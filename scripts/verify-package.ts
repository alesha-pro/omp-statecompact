import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const projectDir = resolve(import.meta.dir, "..");
const tempDir = await mkdtemp(join(tmpdir(), "omp-statecompact-package-"));
const unpacked = join(tempDir, "package");
const bun = Bun.which("bun");
if (!bun) throw new Error("Could not find the active bun executable on PATH");

async function run(
	command: string[],
	options: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number } = {},
) {
	const proc = Bun.spawn(command, {
		cwd: options.cwd ?? projectDir,
		env: options.env ? { ...process.env, ...options.env } : process.env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, options.timeoutMs ?? 120_000);
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	clearTimeout(timeout);
	if (timedOut) throw new Error(`${command.join(" ")} exceeded its timeout`);
	if (exitCode !== 0) throw new Error(`${command.join(" ")} failed (${exitCode})\n${stdout}${stderr}`);
	return { stdout, stderr };
}

try {
	const projectManifest = JSON.parse(await readFile(join(projectDir, "package.json"), "utf8")) as { version?: unknown };
	if (typeof projectManifest.version !== "string") throw new Error("package.json version is missing");
	const archive = join(tempDir, `omp-statecompact-${projectManifest.version}.tgz`);
	await run([bun, "pm", "pack", "--destination", tempDir]);
	await run(["tar", "-xzf", archive, "-C", tempDir]);

	const required = ["package.json", "README.md", "LICENSE", "src/index.ts", "src/extractor.txt"];
	for (const path of required) {
		if (!(await Bun.file(join(unpacked, path)).exists())) throw new Error(`Packed artifact is missing ${path}`);
	}
	const packedFiles = (await readdir(unpacked, { recursive: true })).map(path => String(path));
	for (const forbidden of ["benchmark/results", "node_modules", "releases", ".env", "test/"]) {
		if (packedFiles.some(path => path === forbidden || path.startsWith(`${forbidden}/`))) {
			throw new Error(`Packed artifact contains forbidden path ${forbidden}`);
		}
	}

	await run([bun, "install", "--production", "--ignore-scripts", "--save-text-lockfile"], { cwd: unpacked });
	if (await Bun.file(join(unpacked, "node_modules", "@oh-my-pi", "pi-coding-agent", "package.json")).exists()) {
		throw new Error("Production artifact installed a duplicate pi-coding-agent runtime");
	}

	const packedManifest = JSON.parse(await readFile(join(unpacked, "package.json"), "utf8")) as {
		dependencies?: Record<string, string>;
	};
	const auditDir = join(tempDir, "runtime-audit");
	await mkdir(auditDir);
	await writeFile(
		join(auditDir, "package.json"),
		`${JSON.stringify({ name: "statecompact-runtime-audit", private: true, dependencies: packedManifest.dependencies ?? {} }, null, 2)}\n`,
	);
	await run([bun, "install", "--lockfile-only", "--save-text-lockfile"], { cwd: auditDir });
	await run([bun, "audit", "--audit-level=high"], { cwd: auditDir });
	console.log("PASS production runtime dependency audit has no high-severity advisories");
	await run(
		[
			bun,
			"-e",
			'import extension from "./src/index.ts"; if (typeof extension !== "function") process.exit(2);',
		],
		{ cwd: unpacked },
	);

	const omp = process.env.OMP_BIN?.trim() || Bun.which("omp");
	if (!omp) throw new Error("Could not find omp. Put it on PATH or set OMP_BIN.");
	const isolated = join(tempDir, "xdg");
	await mkdir(join(isolated, "data", "omp"), { recursive: true });
	await mkdir(join(isolated, "state", "omp"), { recursive: true });
	await mkdir(join(isolated, "cache", "omp"), { recursive: true });
	const isolatedEnv = {
		XDG_CONFIG_HOME: join(isolated, "config"),
		XDG_DATA_HOME: join(isolated, "data"),
		XDG_STATE_HOME: join(isolated, "state"),
		XDG_CACHE_HOME: join(isolated, "cache"),
		OPENAI_API_KEY: "statecompact-package-verifier-placeholder",
	};
	await run([omp, "plugin", "install", unpacked], { cwd: tempDir, env: isolatedEnv });
	const installed = await run([omp, "plugin", "list", "--json"], { cwd: tempDir, env: isolatedEnv });
	const pluginList = JSON.parse(installed.stdout) as {
		npm?: Array<{ name?: unknown; version?: unknown; manifest?: { extensions?: unknown } }>;
	};
	const installedPlugin = pluginList.npm?.find(plugin => plugin.name === "omp-statecompact");
	if (
		installedPlugin?.version !== projectManifest.version ||
		!Array.isArray(installedPlugin.manifest?.extensions) ||
		!installedPlugin.manifest.extensions.includes("./src/index.ts")
	) {
		throw new Error(`OMP plugin manager did not install the packed manifest\n${installed.stdout}`);
	}
	const proc = Bun.spawn(
		[
			omp,
			"--mode",
			"rpc",
			"--model",
			"openai/gpt-4.1",
			"--no-tools",
			"--no-skills",
			"--no-rules",
			"--no-lsp",
			"--no-pty",
			"--no-title",
		],
		{
			cwd: tempDir,
			env: {
				...process.env,
				...isolatedEnv,
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	proc.stdin.end();
	const timeout = setTimeout(() => proc.kill(), 10_000);
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	clearTimeout(timeout);
	if (exitCode !== 0) throw new Error(`Packaged OMP extension load failed (${exitCode})\n${stderr}`);
	if (!stdout.includes('"name":"statecompact"') || !stdout.includes('"name":"state"')) {
		throw new Error(`Packaged OMP extension did not register its commands\n${stdout.slice(0, 2_000)}`);
	}

	const manifest = JSON.parse(await readFile(join(unpacked, "package.json"), "utf8")) as { version?: unknown };
	console.log(`PASS packed omp-statecompact ${String(manifest.version)} installed and loaded through isolated OMP`);
} finally {
	await rm(tempDir, { recursive: true, force: true });
}
