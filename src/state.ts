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
const DELETE_CUE_RE = /\b(?:delete[ds]?|deleted|remove[ds]?|removed|complete[ds]?|completed|finish(?:ed)?|implement(?:ed|s)?|resolve[ds]?|resolved|revoke[ds]?|revoked|supersede[ds]?|superseded|cancel(?:ed|led|s)?|closed?|done|no longer)\b/i;
const ACTIVE_STATE_CUE_RE = /\b(?:(?:remains?|still)\s+(?:open|pending|unfinished|incomplete)|pending|unfinished|incomplete|not\s+(?:done|complete|completed|finished|implemented|resolved))\b/i;
const REFERENTIAL_COMPLETION_RE = /\b(?:it|that|this|the (?:task|blocker|work|implementation))\b/i;
const VERIFICATION_SUBJECT_RE = /\b(?:test|tests|suite|fixture|gate|gates|verification|verified|replay|recall@\d+|latency|p95|coverage|metric|metrics)\b/i;
const VERIFICATION_RESULT_RE = /(?:\b(?:pass(?:es|ed|ing)?|fail(?:s|ed|ing)?|complet(?:e|ed)|resolv(?:e|ed)|fix(?:ed)|succeed(?:ed|s)?)\b|\b\d+\s*\/\s*\d+\b|\b(?:recall@\d+|p95)\s*(?:=|is)\s*\d)/i;
const NON_AUTHORITATIVE_RE = /\b(?:archived|obsolete|quoted|untrusted|not authoritative)\b/i;
const FUTURE_VERIFICATION_RE = /\b(?:after|before|must|need(?:s)? to|next action|rerun|should|until)\b/i;
const CURRENT_VERIFICATION_RE = /\b(?:current|currently|latest|now|remain(?:s)?|still)\b/i;
const GENERIC_TEST_RESULT_RE = /^(?:(?:complete|completed|done|pass|passed|passing|resolve|resolved|succeed|succeeded|successful|successfully)(?:\s+successfully)?|(?:fail|failed|failing)(?:\s+currently)?)$/i;
const TRACKER_ID_RE = /\b[A-Za-z][A-Za-z0-9]*-\d+\b/g;
const ASSISTANT_EVIDENCE_RE = /^\[Assistant\]:/i;
// Bare "fix"/"finish" are instructions ("Fix the failing case", "Finish
// with a final bun test run"), not completion.
const COMPLETION_EVIDENCE_RE = /\b(?:complete[ds]?|completed|finished|implement(?:ed|s)?|resolve[ds]?|resolved|fixed|closed?|done)\b/i;
// Completion cue words are common code identifiers (task.completed, done:
// false, isFixed()). A sentence that looks like code or tool output is not
// prose completion evidence, even when it mentions those words.
const CODE_EVIDENCE_RE = /[{}]|=>|\b(?:const|let|var|function|import|export|return|require)\b|\.\w+\(/;
const GENERIC_STATE_VALUE_RE = /^(?:active|blocked|false|in[ -]?progress|none|open|pending|todo|true|unknown)$/i;
const EVIDENCE_STOP_TOKENS = new Set([
	"active",
	"add",
	"after",
	"before",
	"complete",
	"completed",
	"current",
	"ensure",
	"fix",
	"implement",
	"implementation",
	"only",
	"open",
	"pending",
	"primary",
	"run",
	"secondary",
	"status",
	"task",
	"tasks",
	"tertiary",
	"verify",
	"verification",
]);

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
	// Small reducers sometimes treat the top-level continuationSummary patch
	// field as a state section. The section is plugin-owned and never patchable,
	// so hoist a slipped string value to the real top-level field (an explicit
	// top-level continuationSummary wins) and drop the slip instead of rejecting
	// the whole patch into a native fallback.
	let hoistedSummary: string | undefined;
	const takeSummarySlip = (value: unknown): void => {
		if (typeof value === "string" && hoistedSummary === undefined) hoistedSummary = value;
	};
	if (Array.isArray(parsed.operations)) {
		const slipped = parsed.operations.filter(
			operation => isRecord(operation) && operation.section === "continuationSummary",
		);
		for (const operation of slipped) {
			if ((operation as Record<string, unknown>).op === "set") takeSummarySlip((operation as Record<string, unknown>).value);
		}
		operations = parsed.operations
			.filter(operation => !(isRecord(operation) && operation.section === "continuationSummary"))
			.map(operation => parseOperation(operation, limits.maxValueChars));
	} else {
		const rawSet = parsed.set === undefined ? {} : parsed.set;
		const rawDelete = parsed.delete === undefined ? {} : parsed.delete;
		if (!isRecord(rawSet) || !isRecord(rawDelete)) {
			throw new Error("Compact patch set and delete must be objects when present");
		}
		let set: Record<string, unknown> = rawSet;
		let deleted: Record<string, unknown> = rawDelete;
		// A common small-model schema slip is to close the top-level object one
		// brace too late, placing the complete delete map at set.delete. The
		// meaning is unambiguous only when no top-level delete map was supplied.
		// Normalize that shape, then run the same deletion-evidence safety checks.
		if ("delete" in set) {
			const nestedDelete = set.delete;
			if (!isRecord(nestedDelete) || Object.keys(deleted).length > 0) {
				throw new Error("set.delete must be the only delete map when nested");
			}
			deleted = nestedDelete;
			const { delete: _nestedDelete, ...remainingSet } = set;
			set = remainingSet;
		}
		if ("continuationSummary" in set) {
			takeSummarySlip(set.continuationSummary);
			const { continuationSummary: _slippedSummary, ...remainingSet } = set;
			set = remainingSet;
		}
		if ("continuationSummary" in deleted) {
			const { continuationSummary: _slippedSummary, ...remainingDelete } = deleted;
			deleted = remainingDelete;
		}
		operations = [];
		for (const [sectionName, values] of Object.entries(set)) {
			if (!SECTION_SET.has(sectionName)) throw new Error(`Unsupported state section: ${sectionName}`);
			if (!isRecord(values)) throw new Error(`set.${sectionName} must be an object keyed by stable state keys`);
			for (const [key, value] of Object.entries(values)) {
				operations.push(parseOperation({ op: "set", section: sectionName, key, value }, limits.maxValueChars));
			}
		}
		for (const [sectionName, keys] of Object.entries(deleted)) {
			if (!SECTION_SET.has(sectionName)) throw new Error(`Unsupported state section: ${sectionName}`);
			if (!Array.isArray(keys) && !isRecord(keys)) {
				throw new Error(`delete.${sectionName} must be an array of keys or an object keyed by keys`);
			}
			const deleteKeys = Array.isArray(keys) ? keys : Object.keys(keys);
			for (const key of deleteKeys) {
				operations.push(parseOperation({ op: "delete", section: sectionName, key }, limits.maxValueChars));
			}
		}
	}
	operations = operations.flatMap(operation => {
		if (
			operation.op !== "set" ||
			operation.section !== "facts" ||
			(operation.key !== "tests" && operation.key !== "test_results" && operation.key !== "verification")
		) {
			return [operation];
		}
		// Reducers sometimes place an aggregate facts.tests object despite the
		// semantic schema. Split independent streams into stable test keys so a
		// later platform update cannot erase an unchanged replay or release gate.
		if (isRecord(operation.value)) {
			return Object.entries(operation.value).map(([key, value]) =>
				parseOperation(
					{ op: "set", section: "tests", key, value, evidence: operation.evidence },
					limits.maxValueChars,
				),
			);
		}
		return [{ ...operation, section: "tests" as const }];
	});
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

	const summarySource = typeof parsed.continuationSummary === "string" ? parsed.continuationSummary : hoistedSummary;
	const continuationSummary = typeof summarySource === "string" ? truncate(summarySource, 12_000) : undefined;
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

function evidenceSentences(text: string): string[] {
	return text
		.split(/(?<=[.!?])\s+|\n+/)
		.map(sentence => sentence.trim())
		.filter(Boolean);
}

// A non-authoritative marker ("untrusted", "archived", "obsolete", "quoted")
// taints the rest of its block: adversarial pastes put the marker in one
// sentence and the payload in the next, and a per-sentence filter lets the
// payload through. The transcript serializer separates messages with blank
// lines, so blocks approximate message boundaries. Assistant blocks (plans,
// reasoning, claims) and tool-call invocations (which embed superseded code
// in old_string) are never evidence: an invocation is not a result, and
// assistant claims are weaker than user statements and tool results.
const EVIDENCE_SKIP_BLOCK_RE = /^\s*\[(?:assistant|tool call)\]:/i;

// Free-text runner reports ("cargo test: 22 passed", "test result: FAILED.",
// bun's " 58 pass / 0 fail") carry no key=value pairs, so assignment-based
// supersession never fires on them; without structural handling every rerun
// of a suite would accumulate as fresh evidence and a superseded failure
// would sit in canonical state next to the pass that fixed it.
const TEST_RUN_OUTCOME_RE =
	/\btest result:\s*(?:ok|failed)|\b\d+\s+(?:tests?\s+)?(?:pass(?:ed|ing)?|fail(?:ed|ing|ures?)?)\b|\b(?:ran|running)\s+\d+\s+tests?\b|\btests?:\s+\d+\s+(?:passed|failed)\b|\bbuild\s+(?:failed|succeeded)\b/i;
const TEST_RUNNER_STREAM_RE =
	/\b(?:cargo(?:\s+nextest)?|bun|deno|npm|pnpm|yarn|go|dotnet|gradlew?|mvn|make)\s+(?:run\s+)?test[a-z]*\b|\b(?:pytest|vitest|jest|mocha|rspec|phpunit|ctest|tox)\b/i;
const GENERIC_RUN_STREAM = "tests";

function runStreamKey(text: string): string {
	const match = text.match(TEST_RUNNER_STREAM_RE);
	if (!match) return GENERIC_RUN_STREAM;
	return match[0].toLowerCase().replace(/\s+run\s+/, " ").replace(/\s+/g, " ").trim();
}

function authoritativeEvidenceBlocks(text: string): Array<{ index: number; sentences: string[] }> {
	const blocks: Array<{ index: number; sentences: string[] }> = [];
	const raw = text.split(/\n{2,}/);
	for (let index = 0; index < raw.length; index += 1) {
		if (EVIDENCE_SKIP_BLOCK_RE.test(raw[index])) continue;
		const kept: string[] = [];
		let tainted = false;
		for (const sentence of evidenceSentences(raw[index])) {
			if (NON_AUTHORITATIVE_RE.test(sentence)) {
				tainted = true;
				continue;
			}
			if (!tainted) kept.push(sentence);
		}
		if (kept.length > 0) blocks.push({ index, sentences: kept });
	}
	return blocks;
}

const TRANSCRIPT_ASSIGNMENT_RE = /\b([A-Za-z][A-Za-z0-9._:/-]{1,80})\s*=\s*([^\s,;"']+)/g;

function stripAssignmentValue(value: string): string {
	return value.replace(/[`.,;:!?)\]]+$/g, "");
}

// Last writer wins: in sessions that track state as key=value updates, a
// sentence quoting a value that a later update replaced is stale evidence.
function finalTranscriptAssignments(text: string): Map<string, string> {
	const finals = new Map<string, string>();
	for (const match of text.matchAll(TRANSCRIPT_ASSIGNMENT_RE)) {
		finals.set(match[1], stripAssignmentValue(match[2]));
	}
	return finals;
}

// A sentence is stale only when every assignment it quotes is superseded; one
// that also states a current value (e.g. "changed port=8080 from port=3000")
// is kept, because dropping it would lose a real update.
function isSupersededEvidence(sentence: string, finals: Map<string, string>): boolean {
	let hasCurrent = false;
	let hasSuperseded = false;
	for (const match of sentence.matchAll(TRANSCRIPT_ASSIGNMENT_RE)) {
		const finalValue = finals.get(match[1]);
		if (finalValue === undefined) continue;
		if (finalValue === stripAssignmentValue(match[2])) hasCurrent = true;
		else hasSuperseded = true;
	}
	return hasSuperseded && !hasCurrent;
}

function evidenceTokens(text: string): string[] {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(token => token.length >= 4 && !EVIDENCE_STOP_TOKENS.has(token));
}

function hasTokenCoverage(scope: string, source: string): boolean {
	const required = [...new Set(evidenceTokens(source))];
	if (required.length < 2) return false;
	const available = [...new Set(evidenceTokens(scope))];
	const related = (left: string, right: string): boolean => {
		if (left === right) return true;
		if (Math.min(left.length, right.length) < 7) return false;
		let prefix = 0;
		while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
		return prefix >= 7;
	};
	const matches = required.filter(token => available.some(candidate => related(token, candidate))).length;
	return matches >= Math.max(2, Math.ceil(required.length * 0.5));
}

function deletionNeedles(previous: CanonicalState, operation: PatchOperation): string[] {
	const previousValue = previous.items[operation.section][operation.key]?.value;
	const needles = [`${operation.section}.${operation.key}`, operation.key];
	if (typeof previousValue === "string" || typeof previousValue === "number" || typeof previousValue === "boolean") {
		const rendered = String(previousValue);
		if (rendered.length >= 3 && !GENERIC_STATE_VALUE_RE.test(rendered.trim())) needles.push(rendered);
	}
	return needles;
}

function mentionsDeletionTarget(
	text: string,
	operation: PatchOperation,
	previousValue: JsonValue | undefined,
	needles: string[],
): boolean {
	const lower = text.toLowerCase();
	if (needles.some(needle => lower.includes(needle.toLowerCase()))) return true;
	if (hasTokenCoverage(text, operation.key)) return true;
	return typeof previousValue === "string" && hasTokenCoverage(text, previousValue);
}

function hasDeletionEvidence(previous: CanonicalState, operation: PatchOperation, text: string): boolean {
	if (operation.op !== "delete" || !previous.items[operation.section][operation.key]) return true;
	const previousValue = previous.items[operation.section][operation.key]?.value;
	const needles = deletionNeedles(previous, operation);
	const sentences = evidenceSentences(text);
	for (let index = 0; index < sentences.length; index += 1) {
		const sentence = sentences[index];
		if (!DELETE_CUE_RE.test(sentence)) continue;
		// Completion can be expressed across a short discourse window: e.g. the
		// first sentence names the remaining shards, the next reports 100%, and
		// the third says the backfill is complete. Never borrow following text.
		const start = Math.max(0, index - 2);
		const scopeSentences = sentences.slice(start, index + 1);
		const currentNamesTarget = mentionsDeletionTarget(sentence, operation, previousValue, needles);
		const currentRefersBack = REFERENTIAL_COMPLETION_RE.test(sentence);
		const contradictoryActiveState = scopeSentences.some((candidate, candidateIndex) => {
			if (!ACTIVE_STATE_CUE_RE.test(candidate)) return false;
			if (!mentionsDeletionTarget(candidate, operation, previousValue, needles)) return false;
			// A later, target-specific completion or explicit anaphora supersedes an
			// earlier "pending" status. An unrelated completion does not.
			return candidateIndex === scopeSentences.length - 1 || (!currentNamesTarget && !currentRefersBack);
		});
		if (contradictoryActiveState) continue;
		const scope = scopeSentences.join(" ");
		if (mentionsDeletionTarget(scope, operation, previousValue, needles)) return true;
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

export function reconcileExplicitClosures(
	previous: CanonicalState,
	patch: StatePatch,
	transcript: string,
): StatePatch {
	const operations = [...patch.operations];
	const touched = new Set(operations.map(operation => `${operation.section}\u0000${operation.key}`));
	for (const section of ["tasks", "blockers"] as const) {
		for (const key of Object.keys(previous.items[section])) {
			if (touched.has(`${section}\u0000${key}`)) continue;
			const deletion: PatchOperation = { op: "delete", section, key };
			if (hasDeletionEvidence(previous, deletion, transcript)) operations.push(deletion);
		}
	}
	return { ...patch, operations };
}

export function reconcileExplicitVerificationEvidence(patch: StatePatch, transcript: string): StatePatch {
	// The last-writer-wins map must come from authoritative text only: an
	// untrusted echo near the end would otherwise re-assert stale values last
	// and make the genuinely superseded sentences look current.
	const blocks = authoritativeEvidenceBlocks(transcript);
	const finals = finalTranscriptAssignments(blocks.flatMap(block => block.sentences).join("\n"));
	const items: Array<{ text: string; stream?: string }> = [];
	let lastReport: { item: { text: string; stream?: string }; endIndex: number } | undefined;
	for (const { index, sentences } of blocks) {
		const blockText = sentences.join(" ");
		const outcomes = sentences.filter(
			sentence => !ASSISTANT_EVIDENCE_RE.test(sentence) && TEST_RUN_OUTCOME_RE.test(sentence),
		);
		// An instruction about a future run ("run bun test until it passes")
		// is not a run report even when it quotes counts.
		const isRunReport =
			outcomes.length > 0 && !(FUTURE_VERIFICATION_RE.test(blockText) && !CURRENT_VERIFICATION_RE.test(blockText));
		if (isRunReport) {
			const stream = runStreamKey(blockText);
			// Raw-adjacent report blocks are one uninterrupted reporter
			// emission (a multi-suite cargo run split by its own blank lines).
			// Two distinct runs are never raw-adjacent in a serialized
			// transcript: the rerun's tool call always sits between them.
			if (
				lastReport &&
				lastReport.endIndex === index - 1 &&
				(stream === GENERIC_RUN_STREAM || stream === lastReport.item.stream)
			) {
				lastReport.item.text = truncate(`${lastReport.item.text} ${outcomes.join(" ")}`, 400) ?? lastReport.item.text;
				lastReport.endIndex = index;
				continue;
			}
			// Non-outcome sentences in a runner block are compiler/reporter
			// noise, not independent verification statements.
			const text = truncate(outcomes.join(" "), 400);
			if (text) {
				const item = { text, stream };
				items.push(item);
				lastReport = { item, endIndex: index };
			}
			continue;
		}
		for (const sentence of sentences) {
			if (ASSISTANT_EVIDENCE_RE.test(sentence)) continue;
			if (!VERIFICATION_SUBJECT_RE.test(sentence) || !VERIFICATION_RESULT_RE.test(sentence)) continue;
			// Test SOURCE quotes verification words in test names
			// (test("fails with usage message", () => {) without being a
			// result; code-shaped sentences are never verification prose.
			if (CODE_EVIDENCE_RE.test(sentence)) continue;
			if (FUTURE_VERIFICATION_RE.test(sentence) && !CURRENT_VERIFICATION_RE.test(sentence)) continue;
			if (!isSupersededEvidence(sentence, finals)) items.push({ text: sentence });
		}
	}
	// A rerun of a suite supersedes its previous report: keep only the last
	// report per runner stream. A report with no recognizable runner name
	// (runner banners often land in a neighbouring block of the same tool
	// result) belongs to the only named stream when exactly one exists.
	const named = new Set(
		items
			.map(item => item.stream)
			.filter((stream): stream is string => stream !== undefined && stream !== GENERIC_RUN_STREAM),
	);
	const soleStream = named.size === 1 ? [...named][0] : undefined;
	for (const item of items) {
		if (item.stream === GENERIC_RUN_STREAM && soleStream) item.stream = soleStream;
	}
	const lastByStream = new Map<string, { text: string; stream?: string }>();
	for (const item of items) {
		if (item.stream) lastByStream.set(item.stream, item);
	}
	const current = items.filter(item => !item.stream || lastByStream.get(item.stream) === item);
	const evidence = [...new Set(current.map(item => item.text))].slice(-6).join(" ");
	if (!evidence) return patch;
	const operations = patch.operations.filter(
		operation => operation.section !== "tests" || operation.key !== "evidence.current",
	);
	operations.push({
		op: "set",
		section: "tests",
		key: "evidence.current",
		value: truncate(evidence, 3_000) ?? evidence,
	});
	return { ...patch, operations };
}

export function reconcileSpecificTestEvidence(previous: CanonicalState, patch: StatePatch): StatePatch {
	const operations = patch.operations.filter(operation => {
		if (operation.op !== "set" || operation.section !== "tests" || typeof operation.value !== "string") return true;
		const previousValue = previous.items.tests[operation.key]?.value;
		if (typeof previousValue !== "string" || !GENERIC_TEST_RESULT_RE.test(operation.value.trim())) return true;
		const identifiers = previousValue.match(TRACKER_ID_RE) ?? [];
		if (identifiers.length === 0) return true;
		const next = operation.value.toLowerCase();
		return identifiers.some(identifier => next.includes(identifier.toLowerCase()));
	});
	return operations.length === patch.operations.length ? patch : { ...patch, operations };
}

export function reconcileExplicitCompletionEvidence(patch: StatePatch, transcript: string): StatePatch {
	const blocks = authoritativeEvidenceBlocks(transcript);
	const finals = finalTranscriptAssignments(blocks.flatMap(block => block.sentences).join("\n"));
	const candidates: string[] = [];
	for (const { sentences } of blocks) {
		// Runner and build output is verification evidence with last-run-wins
		// semantics, owned by the verification reconciler; quoting it here as
		// completion prose would present a superseded failure as a current fact.
		if (sentences.some(sentence => TEST_RUN_OUTCOME_RE.test(sentence))) continue;
		for (const sentence of sentences) {
			if (ASSISTANT_EVIDENCE_RE.test(sentence)) continue;
			if (!COMPLETION_EVIDENCE_RE.test(sentence)) continue;
			if (CODE_EVIDENCE_RE.test(sentence)) continue;
			if (FUTURE_VERIFICATION_RE.test(sentence) && !CURRENT_VERIFICATION_RE.test(sentence)) continue;
			if (!isSupersededEvidence(sentence, finals)) candidates.push(sentence);
		}
	}
	const evidence = [...new Set(candidates)].slice(-6).join(" ");
	if (!evidence) return patch;
	const operations = patch.operations.filter(
		operation => operation.section !== "facts" || operation.key !== "evidence.completed.current",
	);
	operations.push({
		op: "set",
		section: "facts",
		key: "evidence.completed.current",
		value: truncate(evidence, 3_000) ?? evidence,
	});
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

	// One stable key must not live in two sections with different primitive
	// values: a reducer that writes the new value under facts while leaving
	// its stale constraints twin untouched creates a self-contradictory
	// state. Structured values (decision objects, file lists) are exempt
	// because some keys are intentionally kept in two shapes.
	const projectedByKey = new Map<string, Map<string, JsonValue>>();
	for (const section of STATE_SECTIONS) {
		for (const [key, item] of Object.entries(previous.items[section])) {
			if (section === "workspace" && (key === "files.read" || key === "files.modified")) continue;
			const sections = projectedByKey.get(key) ?? new Map<string, JsonValue>();
			sections.set(section, item.value);
			projectedByKey.set(key, sections);
		}
	}
	// Only keys this patch touches are checked: a legacy contradiction that
	// predates the guard must not reject every future patch forever — it is
	// surfaced the next time a reducer writes either twin.
	const touchedKeys = new Set<string>();
	for (const operation of patch.operations) {
		if (operation.section === "workspace" && (operation.key === "files.read" || operation.key === "files.modified")) continue;
		touchedKeys.add(operation.key);
		const sections = projectedByKey.get(operation.key) ?? new Map<string, JsonValue>();
		if (operation.op === "set") sections.set(operation.section, operation.value as JsonValue);
		else sections.delete(operation.section);
		if (sections.size === 0) projectedByKey.delete(operation.key);
		else projectedByKey.set(operation.key, sections);
	}
	// A goal that quotes a superseded value is a stale narrative: replacing
	// (or delete+set renaming) constraints.sort.order without rewriting the
	// goal text leaves the old mode advertised as current. Prose cannot be
	// rewritten deterministically, so reject with the exact token and let
	// the repair loop return it to the reducer. Evidence keys and long prose
	// values are exempt: their churn tokens are not state values.
	const allSetTokens = new Set<string>();
	for (const operation of patch.operations) {
		if (operation.op === "set" && typeof operation.value === "string") {
			for (const token of evidenceTokens(operation.value)) allSetTokens.add(token);
		}
	}
	// Sources are the mutable-value sections only. A deleted completed task
	// or a reworded test result legitimately shares topic words with goals;
	// treating those as superseded values would reject honest patches.
	const droppedValueTokens = new Map<string, string>();
	for (const operation of patch.operations) {
		if (operation.section !== "constraints" && operation.section !== "facts" && operation.section !== "workspace") continue;
		if (operation.key.includes("evidence")) continue;
		const previousValue = previous.items[operation.section][operation.key]?.value;
		if (typeof previousValue !== "string" || previousValue.length > 120) continue;
		if (operation.op === "set" && (typeof operation.value !== "string" || operation.value === previousValue)) continue;
		for (const token of evidenceTokens(previousValue)) {
			if (token.length >= 5 && /^[a-z]+$/.test(token) && !allSetTokens.has(token)) {
				droppedValueTokens.set(token, `${operation.section}.${operation.key}`);
			}
		}
	}
	if (droppedValueTokens.size > 0) {
		const goalKeys = new Set([
			...Object.keys(previous.items.goals),
			...patch.operations.filter(operation => operation.section === "goals").map(operation => operation.key),
		]);
		for (const goalKey of goalKeys) {
			const projected = projectedValue(previous, patch, "goals", goalKey);
			if (typeof projected !== "string") continue;
			const goalTokens = new Set(evidenceTokens(projected));
			for (const [token, source] of droppedValueTokens) {
				if (goalTokens.has(token)) {
					throw new Error(
						`Unsafe state patch: goals.${goalKey} still quotes superseded value "${token}" (replaced in ${source}); rewrite that goal text to the current value`,
					);
				}
			}
		}
	}

	for (const [key, sections] of projectedByKey) {
		if (!touchedKeys.has(key) || sections.size < 2) continue;
		const rendered = [...sections.entries()]
			.filter((entry): entry is [StateSection, string | number | boolean | null] =>
				entry[1] === null || ["string", "number", "boolean"].includes(typeof entry[1]),
			)
			.map(([section, value]) => [section, JSON.stringify(value)] as const);
		if (rendered.length < 2) continue;
		const distinct = new Set(rendered.map(([, value]) => value));
		if (distinct.size > 1) {
			throw new Error(
				`Unsafe state patch: key ${key} has conflicting values across sections (${rendered
					.map(([section, value]) => `${section}=${value}`)
					.join(" vs ")}); keep one stable key in one section`,
			);
		}
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

function renderSectionValue(section: StateSection, value: JsonValue): string {
	const rendered = renderValue(value);
	if (section !== "decisions" || !isRecord(value) || !("rejected" in value) || !isJsonValue(value.rejected)) {
		return rendered;
	}
	const rejectedValues = Array.isArray(value.rejected) ? value.rejected : [value.rejected];
	const markers = rejectedValues.map(rejected => {
		if (typeof rejected !== "string") return `${renderValue(rejected)} — rejected`;
		const words = rejected.trim().split(/\s+/);
		const label = words.length > 4 ? words.slice(0, 4).join(" ") : rejected;
		return `${label} — rejected`;
	});
	return `${rendered}; rejection markers: ${markers.join("; ")}.`;
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
		"Semantic contract: Open tasks are unfinished and blockers are unresolved. Active constraints and decision choices are required, not rejected or completed. Only alternatives explicitly inside a decision's `rejected` value are rejected. A future rollout, cutover, retention window, or gate is not completed unless current state explicitly says it completed. A test result marked passing means its corresponding named verification gate passed.",
	];

	for (const sectionName of STATE_SECTIONS) {
		const entries = Object.entries(state.items[sectionName]).sort(([left], [right]) => left.localeCompare(right));
		if (entries.length === 0) continue;
		lines.push("", `## ${SECTION_TITLES[sectionName]}`);
		for (const [key, item] of entries) lines.push(`- ${key}: ${renderSectionValue(sectionName, item.value)}`);
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
