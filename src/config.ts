import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StateCompactConfig } from "./types.ts";

export const DEFAULT_CONFIG: StateCompactConfig = {
	maxOutputTokens: 4096,
	timeoutMs: 25_000,
	disableReasoning: true,
	maxInputFraction: 0.92,
	maxOperations: 256,
	maxValueChars: 12_000,
	tombstoneLimit: 128,
	fileHistoryLimit: 200,
	notify: true,
};

const CONFIG_KEYS = new Set([
	"model",
	"maxOutputTokens",
	"timeoutMs",
	"disableReasoning",
	"maxInputFraction",
	"maxOperations",
	"maxValueChars",
	"tombstoneLimit",
	"fileHistoryLimit",
	"notify",
]);

function boundedNumber(
	source: Record<string, unknown>,
	key: keyof StateCompactConfig,
	fallback: number,
	min: number,
	max: number,
	integer = true,
): number {
	if (!(key in source)) return fallback;
	const value = source[key];
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < min ||
		value > max ||
		(integer && !Number.isInteger(value))
	) {
		throw new Error(`${String(key)} must be ${integer ? "an integer" : "a number"} between ${min} and ${max}`);
	}
	return value;
}

function booleanValue(
	source: Record<string, unknown>,
	key: "disableReasoning" | "notify",
	fallback: boolean,
): boolean {
	if (!(key in source)) return fallback;
	if (typeof source[key] !== "boolean") throw new Error(`${key} must be a boolean`);
	return source[key];
}

export function loadConfig(cwd: string, flagModel?: string): StateCompactConfig {
	const path = join(cwd, ".omp", "statecompact.json");
	let source: Record<string, unknown> = {};
	if (existsSync(path)) {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} must contain a JSON object`);
		source = parsed as Record<string, unknown>;
		const unknown = Object.keys(source).filter(key => !CONFIG_KEYS.has(key));
		if (unknown.length > 0) throw new Error(`${path} contains unknown option${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
	}

	const envModel = process.env.STATECOMPACT_MODEL?.trim();
	if ("model" in source && typeof source.model !== "string") throw new Error("model must be a string");
	const fileModel = typeof source.model === "string" ? source.model.trim() : undefined;
	const model = flagModel?.trim() || envModel || fileModel || undefined;
	return {
		...(model ? { model } : {}),
		maxOutputTokens: boundedNumber(source, "maxOutputTokens", DEFAULT_CONFIG.maxOutputTokens, 512, 32_768),
		timeoutMs: boundedNumber(source, "timeoutMs", DEFAULT_CONFIG.timeoutMs, 1_000, 29_000),
		disableReasoning: booleanValue(source, "disableReasoning", DEFAULT_CONFIG.disableReasoning),
		maxInputFraction: boundedNumber(source, "maxInputFraction", DEFAULT_CONFIG.maxInputFraction, 0.5, 0.98, false),
		maxOperations: boundedNumber(source, "maxOperations", DEFAULT_CONFIG.maxOperations, 1, 2_000),
		maxValueChars: boundedNumber(source, "maxValueChars", DEFAULT_CONFIG.maxValueChars, 100, 100_000),
		tombstoneLimit: boundedNumber(source, "tombstoneLimit", DEFAULT_CONFIG.tombstoneLimit, 0, 2_000),
		fileHistoryLimit: boundedNumber(source, "fileHistoryLimit", DEFAULT_CONFIG.fileHistoryLimit, 10, 5_000),
		notify: booleanValue(source, "notify", DEFAULT_CONFIG.notify),
	};
}
