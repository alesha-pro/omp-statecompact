import {
	STATE_SECTIONS,
	type CanonicalState,
	type JsonValue,
	type PatchOperation,
	type StateCompactPayload,
	type StateItem,
	type StatePatch,
	type StateSection,
	type Tombstone,
} from "./types.ts";

const SECTION_SET = new Set<string>(STATE_SECTIONS);
const KEY_RE = /^[a-z0-9][a-z0-9._:/-]{0,159}$/;
const STATECOMPACT_MARKER_RE = /<statecompact revision="\d+" schema="1" \/>/;
const MAX_PERSISTED_ITEMS = 2_000;
const MAX_PERSISTED_TOMBSTONES = 2_000;
const MAX_JSON_DEPTH = 20;
const DELETE_CUE_RE = /\b(?:delete[ds]?|deleted|remove[ds]?|removed|complete[ds]?|completed|finish(?:ed)?|resolve[ds]?|resolved|revoke[ds]?|revoked|supersede[ds]?|superseded|cancel(?:ed|led|s)?|closed?|done|no longer)\b/i;

export interface PatchSafetyEvidence {
	deletionEvidenceText?: string;
	bridgedPreviousSummary?: string;
	newerTranscript?: string;
}

export function shouldBridgePreviousSummary(summary: string | undefined): boolean {
	return typeof summary === "string" && summary.trim().length > 0 && !STATECOMPACT_MARKER_RE.test(summary);
}

export function createEmptyState(): CanonicalState {
	return {
		schemaVersion: 1,
		revision: 0,
		continuationSummary: "",
		items: {
			goals: {},
			constraints: {},
			facts: {},
			decisions: {},
			workspace: {},
			tests: {},
			tasks: {},
			blockers: {},
		},
		tombstones: [],
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
	if (depth > MAX_JSON_DEPTH) return false;
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(item => isJsonValue(item, depth + 1));
	return isRecord(value) && Object.values(value).every(item => isJsonValue(item, depth + 1));
}

function truncate(text: string | undefined, limit: number): string | undefined {
	if (!text) return undefined;
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

function unwrapInternalStateItem(value: unknown): unknown {
	if (!isRecord(value) || !("value" in value) || typeof value.updatedAtRevision !== "number") return value;
	const keys = Object.keys(value);
	if (keys.some(key => key !== "value" && key !== "evidence" && key !== "updatedAtRevision")) return value;
	return value.value;
}

export function normalizeStateKey(value: string): string {
	const normalized = value
		.normalize("NFKC")
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "_")
		.replace(/[^a-z0-9._:/-]+/g, "-")
		.replace(/_-+|-+_/g, "-")
		.replace(/^[-._:/]+|[-._:/]+$/g, "")
		.slice(0, 160);
	if (!KEY_RE.test(normalized)) throw new Error(`Invalid state key: ${value}`);
	return normalized;
}

function findJsonObjects(text: string): string[] {
	const candidates: string[] = [];
	let start = -1;
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "{") {
			if (depth === 0) start = index;
			depth += 1;
		} else if (char === "}" && depth > 0) {
			depth -= 1;
			if (depth === 0 && start >= 0) {
				candidates.push(text.slice(start, index + 1));
				start = -1;
			}
		}
	}

	return candidates;
}

function parseOperation(value: unknown, maxValueChars: number): PatchOperation {
	if (!isRecord(value)) throw new Error("Patch operation must be an object");
	if (value.op !== "set" && value.op !== "delete") throw new Error(`Unsupported operation: ${String(value.op)}`);
	if (typeof value.section !== "string" || !SECTION_SET.has(value.section)) {
		throw new Error(`Unsupported state section: ${String(value.section)}`);
	}
	if (typeof value.key !== "string") {
		throw new Error(`Invalid state key: ${String(value.key)}`);
	}
	const key = normalizeStateKey(value.key);

	const base = {
		section: value.section as StateSection,
		key,
		evidence: truncate(typeof value.evidence === "string" ? value.evidence : undefined, 500),
	};

	if (value.op === "delete") return { op: "delete", ...base };
	if (!("value" in value)) throw new Error(`Invalid JSON value for ${value.section}.${key}`);
	const unwrappedValue = unwrapInternalStateItem(value.value);
	if (!isJsonValue(unwrappedValue)) throw new Error(`Invalid JSON value for ${value.section}.${key}`);
	if (JSON.stringify(unwrappedValue).length > maxValueChars) throw new Error(`Value too large for ${value.section}.${key}`);
	return { op: "set", ...base, value: unwrappedValue };
}

export function parseStatePatch(text: string, limits: { maxOperations: number; maxValueChars: number }): StatePatch {
	let parsed: unknown;
	for (const candidate of findJsonObjects(text)) {
		try {
			const value = JSON.parse(candidate) as unknown;
			if (isRecord(value) && (Array.isArray(value.operations) || isRecord(value.set) || isRecord(value.delete))) {
				parsed = value;
				break;
			}
		} catch {
			// Try the next balanced JSON object. Thinking blocks often contain braces.
		}
	}

	if (!isRecord(parsed)) throw new Error("Model did not return a valid JSON patch");
	if (parsed.schemaVersion !== 1) throw new Error(`Unsupported patch schema: ${String(parsed.schemaVersion)}`);

	let operations: PatchOperation[];
	if (Array.isArray(parsed.operations)) {
		operations = parsed.operations.map(operation => parseOperation(operation, limits.maxValueChars));
	} else {
		const set = parsed.set === undefined ? {} : parsed.set;
		const deleted = parsed.delete === undefined ? {} : parsed.delete;
		if (!isRecord(set) || !isRecord(deleted)) {
			throw new Error("Compact patch set and delete must be objects when present");
		}
		operations = [];
		for (const [sectionName, values] of Object.entries(set)) {
			if (!SECTION_SET.has(sectionName) || !isRecord(values)) {
				throw new Error(`Unsupported state section: ${sectionName}`);
			}
			for (const [key, value] of Object.entries(values)) {
				operations.push(parseOperation({ op: "set", section: sectionName, key, value }, limits.maxValueChars));
			}
		}
		for (const [sectionName, keys] of Object.entries(deleted)) {
			if (!SECTION_SET.has(sectionName) || (!Array.isArray(keys) && !isRecord(keys))) {
				throw new Error(`Unsupported state section: ${sectionName}`);
			}
			const deleteKeys = Array.isArray(keys) ? keys : Object.keys(keys);
			for (const key of deleteKeys) {
				operations.push(parseOperation({ op: "delete", section: sectionName, key }, limits.maxValueChars));
			}
		}
	}
	if (operations.length > limits.maxOperations) {
		throw new Error(`Patch has ${operations.length} operations; limit is ${limits.maxOperations}`);
	}
	operations = operations.filter(operation => {
		if (operation.key === "workspace.files.read" || operation.key === "workspace.files.modified") return false;
		if (operation.section === "workspace" && (operation.key === "files.read" || operation.key === "files.modified")) {
			return false;
		}
		return true;
	});
	// Some otherwise-correct reducers redundantly emit a changed key in both
	// `set` and `delete`. The wire contract defines a replacement as `set`, so
	// resolve that one unambiguous conflict deterministically instead of losing
	// the entire compaction to a native fallback.
	const setOperationKeys = new Set(
		operations
			.filter(operation => operation.op === "set")
			.map(operation => `${operation.section}\u0000${operation.key}`),
	);
	operations = operations.filter(
		operation => operation.op === "set" || !setOperationKeys.has(`${operation.section}\u0000${operation.key}`),
	);

	const continuationSummary =
		typeof parsed.continuationSummary === "string" ? truncate(parsed.continuationSummary, 12_000) : undefined;
	return {
		schemaVersion: 1,
		operations,
		...(continuationSummary !== undefined ? { continuationSummary } : {}),
	};
}

function cloneState(state: CanonicalState): CanonicalState {
	return structuredClone(state);
}

export function applyPatch(previous: CanonicalState, patch: StatePatch, tombstoneLimit: number): CanonicalState {
	const next = cloneState(previous);
	next.revision += 1;
	if (patch.continuationSummary !== undefined) next.continuationSummary = patch.continuationSummary;

	for (const operation of patch.operations) {
		const section = next.items[operation.section];
		if (operation.op === "set") {
			section[operation.key] = {
				value: operation.value,
				evidence: operation.evidence,
				updatedAtRevision: next.revision,
			};
			next.tombstones = next.tombstones.filter(
				tombstone => tombstone.section !== operation.section || tombstone.key !== operation.key,
			);
			continue;
		}

		delete section[operation.key];
		const tombstone: Tombstone = {
			section: operation.section,
			key: operation.key,
			evidence: operation.evidence,
			deletedAtRevision: next.revision,
		};
		next.tombstones = next.tombstones.filter(
			item => item.section !== operation.section || item.key !== operation.key,
		);
		next.tombstones.push(tombstone);
	}

	if (next.tombstones.length > tombstoneLimit) next.tombstones = next.tombstones.slice(-tombstoneLimit);
	return next;
}

function hasDeletionEvidence(previous: CanonicalState, operation: PatchOperation, text: string): boolean {
	if (operation.op !== "delete" || !previous.items[operation.section][operation.key]) return true;
	const previousValue = previous.items[operation.section][operation.key]?.value;
	const fullPath = `${operation.section}.${operation.key}`;
	const needles = [fullPath, operation.key];
	if (typeof previousValue === "string" || typeof previousValue === "number" || typeof previousValue === "boolean") {
		const rendered = String(previousValue);
		if (rendered.length >= 3) needles.push(rendered);
	}
	const lower = text.toLowerCase();
	for (const needle of needles) {
		const normalizedNeedle = needle.toLowerCase();
		let index = lower.indexOf(normalizedNeedle);
		while (index >= 0) {
			const window = text.slice(Math.max(0, index - 180), Math.min(text.length, index + normalizedNeedle.length + 180));
			if (DELETE_CUE_RE.test(window)) return true;
			index = lower.indexOf(normalizedNeedle, index + normalizedNeedle.length);
		}
	}
	return false;
}

function explicitAssignments(text: string): Array<{ section: StateSection; key: string; value: string }> {
	const pattern = /\b(goals|constraints|facts|decisions|workspace|tests|tasks|blockers)\.([A-Za-z0-9][A-Za-z0-9._:/-]{0,159})\s*=\s*(?:"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`|([^\s,;\n]+))/g;
	const found = new Map<string, { section: StateSection; key: string; value: string }>();
	for (const match of text.matchAll(pattern)) {
		const section = match[1] as StateSection;
		const key = normalizeStateKey(match[2]);
		const value = (match[3] ?? match[4] ?? match[5] ?? match[6] ?? "").trim();
		found.set(`${section}\u0000${key}`, { section, key, value });
	}
	return [...found.values()];
}

function parseExplicitAssignmentValue(raw: string): JsonValue {
	const value = raw.replace(/[`.,;:!?]+$/, "");
	if (value === "true") return true;
	if (value === "false") return false;
	if (value === "null") return null;
	if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
		const numeric = Number(value);
		if (Number.isFinite(numeric)) return numeric;
	}
	return value;
}

export function reconcileFallbackAssignments(
	patch: StatePatch,
	bridgedSummary: string | undefined,
	newerTranscript: string,
): StatePatch {
	if (!bridgedSummary) return patch;
	const newer = newerTranscript.toLowerCase();
	const operations = [...patch.operations];
	for (const assignment of explicitAssignments(bridgedSummary)) {
		const fullPath = `${assignment.section}.${assignment.key}`;
		if (newer.includes(fullPath.toLowerCase())) continue;
		for (let index = operations.length - 1; index >= 0; index -= 1) {
			const operation = operations[index];
			if (operation.section === assignment.section && operation.key === assignment.key) operations.splice(index, 1);
		}
		operations.push({
			op: "set",
			section: assignment.section,
			key: assignment.key,
			value: parseExplicitAssignmentValue(assignment.value),
		});
	}
	return { ...patch, operations };
}

function projectedValue(previous: CanonicalState, patch: StatePatch, section: StateSection, key: string): JsonValue | undefined {
	let value: JsonValue | undefined = previous.items[section][key]?.value;
	for (const operation of patch.operations) {
		if (operation.section !== section || operation.key !== key) continue;
		value = operation.op === "set" ? operation.value : undefined;
	}
	return value;
}

function assertFallbackAssignmentsPreserved(
	previous: CanonicalState,
	patch: StatePatch,
	bridgedSummary: string,
	newerTranscript: string,
): void {
	const newer = newerTranscript.toLowerCase();
	for (const assignment of explicitAssignments(bridgedSummary)) {
		const fullPath = `${assignment.section}.${assignment.key}`;
		if (newer.includes(fullPath.toLowerCase())) continue;
		const projected = projectedValue(previous, patch, assignment.section, assignment.key);
		const rendered = typeof projected === "string" ? projected : projected === undefined ? "" : JSON.stringify(projected);
		const expected = [assignment.value, assignment.value.replace(/[.;]$/, "")];
		if (!expected.includes(rendered)) {
			throw new Error(`Unsafe state patch: omitted explicit fallback assignment ${fullPath}`);
		}
	}
}

export function assertPatchSafe(previous: CanonicalState, patch: StatePatch, evidence: PatchSafetyEvidence = {}): void {
	const operationKey = (operation: PatchOperation) => `${operation.section}\u0000${operation.key}`;
	const setKeys = new Set(patch.operations.filter(operation => operation.op === "set").map(operationKey));
	const deleteKeys = new Set(patch.operations.filter(operation => operation.op === "delete").map(operationKey));
	const conflictingKeys = [...setKeys].filter(key => deleteKeys.has(key));
	if (conflictingKeys.length > 0) {
		throw new Error(`Unsafe state patch: ${conflictingKeys.length} keys are both set and deleted`);
	}
	if (evidence.deletionEvidenceText) {
		for (const operation of patch.operations) {
			if (!hasDeletionEvidence(previous, operation, evidence.deletionEvidenceText)) {
				throw new Error(`Unsafe state patch: delete ${operation.section}.${operation.key} lacks explicit evidence`);
			}
		}
	}
	if (evidence.bridgedPreviousSummary) {
		assertFallbackAssignmentsPreserved(
			previous,
			patch,
			evidence.bridgedPreviousSummary,
			evidence.newerTranscript ?? "",
		);
	}

	const projected = new Set<string>();
	const previousItems = STATE_SECTIONS.reduce((total, section) => {
		const keys = Object.keys(previous.items[section]).filter(
			key => section !== "workspace" || (key !== "files.read" && key !== "files.modified"),
		);
		for (const key of keys) projected.add(`${section}\u0000${key}`);
		return total + keys.length;
	}, 0);
	const deletes = patch.operations.filter(operation => operation.op === "delete").length;
	const sets = patch.operations.filter(operation => operation.op === "set").length;
	for (const operation of patch.operations) {
		if (operation.section === "workspace" && (operation.key === "files.read" || operation.key === "files.modified")) continue;
		if (operation.op === "set") projected.add(operationKey(operation));
		else projected.delete(operationKey(operation));
	}
	const massDeleteThreshold = Math.max(8, Math.ceil(previousItems * 0.5));
	const projectedFloor = Math.ceil(previousItems * 0.5);
	if (
		previousItems >= 8 &&
		deletes >= massDeleteThreshold &&
		(sets * 2 < deletes || projected.size < projectedFloor)
	) {
		throw new Error(
			`Unsafe state patch: ${deletes} deletes and ${sets} sets would collapse ${previousItems} existing items to ${projected.size}`,
		);
	}
}

function toStringArray(value: StateItem | undefined): string[] {
	if (!value || !Array.isArray(value.value)) return [];
	return value.value.filter((item): item is string => typeof item === "string");
}

export function mergeFileHistory(
	state: CanonicalState,
	fileOps: { read: Iterable<string>; written: Iterable<string>; edited: Iterable<string> },
	limit: number,
): CanonicalState {
	const next = cloneState(state);
	const revision = next.revision;
	const oldRead = toStringArray(next.items.workspace["files.read"]);
	const oldModified = toStringArray(next.items.workspace["files.modified"]);
	const appendRecent = (values: string[], additions: Iterable<string>): string[] => {
		for (const addition of additions) {
			const existing = values.indexOf(addition);
			if (existing >= 0) values.splice(existing, 1);
			values.push(addition);
		}
		return values;
	};
	const modified = new Set(appendRecent([...oldModified], [...fileOps.written, ...fileOps.edited]));
	const read = new Set(appendRecent([...oldRead], fileOps.read));
	for (const path of modified) read.delete(path);

	const setList = (key: string, values: Set<string>) => {
		const ordered = [...values];
		const bounded = ordered.length > limit ? ordered.slice(-limit) : ordered;
		next.items.workspace[key] = {
			value: bounded,
			evidence: `Deterministic OMP file-operation scan; ${ordered.length} unique paths`,
			updatedAtRevision: revision,
		};
	};
	setList("files.read", read);
	setList("files.modified", modified);
	return next;
}

function renderValue(value: JsonValue): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value);
}

const SECTION_TITLES: Record<StateSection, string> = {
	goals: "Goals",
	constraints: "Active constraints",
	facts: "Current facts",
	decisions: "Active decisions",
	workspace: "Workspace",
	tests: "Tests and verification",
	tasks: "Open tasks",
	blockers: "Blockers",
};

export function renderCanonicalState(state: CanonicalState): string {
	const lines = [
		"# Canonical task state (StateCompact)",
		"",
		"This is the authoritative state for the compacted history. If older compacted facts conflict with it, use this state. Messages kept after this compaction are newer and may supersede it.",
	];

	for (const sectionName of STATE_SECTIONS) {
		const entries = Object.entries(state.items[sectionName]).sort(([left], [right]) => left.localeCompare(right));
		if (entries.length === 0) continue;
		lines.push("", `## ${SECTION_TITLES[sectionName]}`);
		for (const [key, item] of entries) lines.push(`- ${key}: ${renderValue(item.value)}`);
	}

	if (state.continuationSummary) {
		lines.push("", "## Continuation notes", state.continuationSummary);
	}

	lines.push("", `<statecompact revision="${state.revision}" schema="1" />`);
	return lines.join("\n");
}

export function countItems(state: CanonicalState): number {
	return STATE_SECTIONS.reduce((total, section) => total + Object.keys(state.items[section]).length, 0);
}

export function isCanonicalState(value: unknown): value is CanonicalState {
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		!Number.isSafeInteger(value.revision) ||
		(value.revision as number) < 0
	) return false;
	if (typeof value.continuationSummary !== "string" || !isRecord(value.items) || !Array.isArray(value.tombstones)) {
		return false;
	}
	if (value.continuationSummary.length > 12_000 || value.tombstones.length > MAX_PERSISTED_TOMBSTONES) return false;
	const items = value.items;
	if (Object.keys(items).length !== STATE_SECTIONS.length || !STATE_SECTIONS.every(section => isRecord(items[section]))) {
		return false;
	}
	let itemCount = 0;
	for (const section of STATE_SECTIONS) {
		for (const [key, item] of Object.entries(items[section] as Record<string, unknown>)) {
			itemCount += 1;
			if (itemCount > MAX_PERSISTED_ITEMS || !KEY_RE.test(key) || !isRecord(item)) return false;
			if (!isJsonValue(item.value)) return false;
			if (
				!Number.isSafeInteger(item.updatedAtRevision) ||
				(item.updatedAtRevision as number) < 0 ||
				(item.updatedAtRevision as number) > (value.revision as number)
			) return false;
			if (item.evidence !== undefined && (typeof item.evidence !== "string" || item.evidence.length > 500)) return false;
		}
	}
	for (const tombstone of value.tombstones) {
		if (!isRecord(tombstone) || typeof tombstone.section !== "string" || !SECTION_SET.has(tombstone.section)) return false;
		if (typeof tombstone.key !== "string" || !KEY_RE.test(tombstone.key)) return false;
		if (
			!Number.isSafeInteger(tombstone.deletedAtRevision) ||
			(tombstone.deletedAtRevision as number) < 0 ||
			(tombstone.deletedAtRevision as number) > (value.revision as number)
		) return false;
		if (tombstone.evidence !== undefined && (typeof tombstone.evidence !== "string" || tombstone.evidence.length > 500)) return false;
	}
	return true;
}

export function readPayload(value: unknown): StateCompactPayload | undefined {
	if (!isRecord(value) || typeof value.pluginVersion !== "string" || !isCanonicalState(value.state)) return undefined;
	if (!isRecord(value.metrics) || typeof value.metrics.model !== "string") return undefined;
	return value as unknown as StateCompactPayload;
}

export function findLatestPayload(entries: readonly unknown[], preserveKey: string): StateCompactPayload | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!isRecord(entry) || entry.type !== "compaction" || !isRecord(entry.preserveData)) continue;
		const payload = readPayload(entry.preserveData[preserveKey]);
		if (payload) return payload;
	}
	return undefined;
}
