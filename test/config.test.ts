import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.ts";

test("reducer deadline stays below OMP's 30 second handler cap", () => {
	expect(DEFAULT_CONFIG.timeoutMs).toBe(25_000);
	expect(DEFAULT_CONFIG.timeoutMs).toBeLessThan(30_000);
});

test("project config accepts only a bounded reducer deadline", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "statecompact-config-"));
	try {
		await mkdir(join(cwd, ".omp"));
		await writeFile(join(cwd, ".omp", "statecompact.json"), JSON.stringify({ timeoutMs: 1_500 }));
		expect(loadConfig(cwd).timeoutMs).toBe(1_500);

		await writeFile(join(cwd, ".omp", "statecompact.json"), JSON.stringify({ timeoutMs: 30_000 }));
		expect(() => loadConfig(cwd)).toThrow("timeoutMs must be an integer between 1000 and 29000");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("project config rejects typos and invalid value types", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "statecompact-config-invalid-"));
	try {
		await mkdir(join(cwd, ".omp"));
		await writeFile(join(cwd, ".omp", "statecompact.json"), JSON.stringify({ timeotMs: 2_000 }));
		expect(() => loadConfig(cwd)).toThrow("unknown option: timeotMs");

		await writeFile(join(cwd, ".omp", "statecompact.json"), JSON.stringify({ notify: "yes" }));
		expect(() => loadConfig(cwd)).toThrow("notify must be a boolean");

		await writeFile(join(cwd, ".omp", "statecompact.json"), JSON.stringify({ maxOperations: 1.5 }));
		expect(() => loadConfig(cwd)).toThrow("maxOperations must be an integer");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
