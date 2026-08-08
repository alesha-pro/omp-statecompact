import { describe, expect, test } from "bun:test";
import {
	applyPatch,
	assertPatchSafe,
	createEmptyState,
	isCanonicalState,
	mergeFileHistory,
	normalizeStateKey,
	parseStatePatch,
	reconcileFallbackAssignments,
	renderCanonicalState,
	shouldBridgePreviousSummary,
} from "../src/state.ts";

const limits = { maxOperations: 20, maxValueChars: 2_000 };

describe("canonical state reducer", () => {
	test("rejects suspicious mass deletion without replacement state", () => {
		const previous = createEmptyState();
		for (let index = 0; index < 12; index += 1) {
			previous.items.facts[`key.${index}`] = { value: `value-${index}`, updatedAtRevision: 1 };
		}
		const destructive = {
			schemaVersion: 1 as const,
			operations: Array.from({ length: 12 }, (_, index) => ({
				op: "delete" as const,
				section: "facts" as const,
				key: `key.${index}`,
			})),
		};
		expect(() => assertPatchSafe(previous, destructive)).toThrow("Unsafe state patch");
	});

	test("allows a large state replacement when deletes have matching sets", () => {
		const previous = createEmptyState();
		for (let index = 0; index < 12; index += 1) {
			previous.items.facts[`old.${index}`] = { value: `old-${index}`, updatedAtRevision: 1 };
		}
		const replacement = {
			schemaVersion: 1 as const,
			operations: [
				...Array.from({ length: 12 }, (_, index) => ({
					op: "delete" as const,
					section: "facts" as const,
					key: `old.${index}`,
				})),
				...Array.from({ length: 12 }, (_, index) => ({
					op: "set" as const,
					section: "facts" as const,
					key: `new.${index}`,
					value: `new-${index}`,
				})),
			],
		};
		expect(() => assertPatchSafe(previous, replacement)).not.toThrow();
	});

	test("rejects a delta that sets and deletes the same keys", () => {
		const previous = createEmptyState();
		for (let index = 0; index < 12; index += 1) {
			previous.items.facts[`key.${index}`] = { value: `old-${index}`, updatedAtRevision: 1 };
		}
		const conflicting = {
			schemaVersion: 1 as const,
			operations: Array.from({ length: 12 }, (_, index) => [
				{ op: "set" as const, section: "facts" as const, key: `key.${index}`, value: `new-${index}` },
				{ op: "delete" as const, section: "facts" as const, key: `key.${index}` },
			]).flat(),
		};
		expect(() => assertPatchSafe(previous, conflicting)).toThrow("both set and deleted");
	});

	test("requires explicit transcript evidence before deleting an existing item", () => {
		const previous = createEmptyState();
		previous.items.tasks.secondary = { value: "task-verify-a", updatedAtRevision: 1 };
		const deletion = {
			schemaVersion: 1 as const,
			operations: [{ op: "delete" as const, section: "tasks" as const, key: "secondary" }],
		};
		expect(() => assertPatchSafe(previous, deletion, { deletionEvidenceText: "Keep all other state unchanged." })).toThrow(
			"lacks explicit evidence",
		);
		expect(() =>
			assertPatchSafe(previous, deletion, { deletionEvidenceText: "The task task-verify-a is completed." }),
		).not.toThrow();
	});

	test("requires explicit assignments from a bridged fallback summary", () => {
		const previous = createEmptyState();
		const missing = { schemaVersion: 1 as const, operations: [] };
		expect(() =>
			assertPatchSafe(previous, missing, {
				bridgedPreviousSummary: "facts.audit.marker=audit-marker-c",
				newerTranscript: "Continue the recovery.",
			}),
		).toThrow("omitted explicit fallback assignment facts.audit.marker");
		const preserved = {
			schemaVersion: 1 as const,
			operations: [{ op: "set" as const, section: "facts" as const, key: "audit.marker", value: "audit-marker-c" }],
		};
		expect(() =>
			assertPatchSafe(previous, preserved, {
				bridgedPreviousSummary: "facts.audit.marker=audit-marker-c",
				newerTranscript: "Continue the recovery.",
			}),
		).not.toThrow();
	});

	test("reconciles explicit fallback assignments without relying on model repair", () => {
		const patch = reconcileFallbackAssignments(
			{
				schemaVersion: 1,
				operations: [
					{ op: "set", section: "facts", key: "audit.marker", value: "wrong" },
					{ op: "delete", section: "facts", key: "runtime.port" },
				],
			},
			"`facts.audit.marker=audit-marker-c` facts.runtime.port=7202 constraints.deploy_freeze=true",
			"Set facts.runtime.port=8502.",
		);
		expect(patch.operations).toEqual([
			{ op: "delete", section: "facts", key: "runtime.port" },
			{ op: "set", section: "facts", key: "audit.marker", value: "audit-marker-c" },
			{ op: "set", section: "constraints", key: "deploy_freeze", value: true },
		]);
	});

	test("lets newer transcript references supersede explicit fallback assignments", () => {
		const previous = createEmptyState();
		const replacement = {
			schemaVersion: 1 as const,
			operations: [{ op: "set" as const, section: "facts" as const, key: "release", value: "release-d" }],
		};
		expect(() =>
			assertPatchSafe(previous, replacement, {
				bridgedPreviousSummary: "facts.release=release-c",
				newerTranscript: "Set facts.release=release-d.",
			}),
		).not.toThrow();
	});

	test("replaces a mutable value instead of retaining both values", () => {
		const first = applyPatch(
			createEmptyState(),
			parseStatePatch('{"schemaVersion":1,"operations":[{"op":"set","section":"facts","key":"runtime.port","value":3000}]}', limits),
			20,
		);
		const second = applyPatch(
			first,
			parseStatePatch('{"schemaVersion":1,"operations":[{"op":"set","section":"facts","key":"runtime.port","value":8080}]}', limits),
			20,
		);
		const rendered = renderCanonicalState(second);
		expect(second.items.facts["runtime.port"]?.value).toBe(8080);
		expect(rendered).toContain("runtime.port: 8080");
		expect(rendered).not.toContain("3000");
	});

	test("handles A to B to A reverts", () => {
		let state = createEmptyState();
		for (const value of ["A", "B", "A"]) {
			state = applyPatch(
				state,
				{ schemaVersion: 1, operations: [{ op: "set", section: "decisions", key: "strategy", value }] },
				20,
			);
		}
		expect(state.items.decisions.strategy?.value).toBe("A");
		expect(renderCanonicalState(state)).not.toContain("strategy: B");
	});

	test("deletes revoked state and records a tombstone", () => {
		const state = applyPatch(
			createEmptyState(),
			{ schemaVersion: 1, operations: [{ op: "set", section: "constraints", key: "runtime.cuda", value: true }] },
			20,
		);
		const deleted = applyPatch(
			state,
			{ schemaVersion: 1, operations: [{ op: "delete", section: "constraints", key: "runtime.cuda", evidence: "revoked" }] },
			20,
		);
		expect(deleted.items.constraints["runtime.cuda"]).toBeUndefined();
		expect(deleted.tombstones).toEqual([
			{ section: "constraints", key: "runtime.cuda", evidence: "revoked", deletedAtRevision: 2 },
		]);
		expect(renderCanonicalState(deleted)).not.toContain("runtime.cuda");
	});

	test("a later set reinstates a tombstoned key", () => {
		let state = createEmptyState();
		state = applyPatch(state, { schemaVersion: 1, operations: [{ op: "delete", section: "facts", key: "feature.x" }] }, 20);
		state = applyPatch(state, { schemaVersion: 1, operations: [{ op: "set", section: "facts", key: "feature.x", value: true }] }, 20);
		expect(state.tombstones).toHaveLength(0);
		expect(state.items.facts["feature.x"]?.value).toBe(true);
	});

	test("empty patches preserve existing facts", () => {
		const state = applyPatch(
			createEmptyState(),
			{ schemaVersion: 1, operations: [{ op: "set", section: "goals", key: "primary", value: "ship plugin" }] },
			20,
		);
		const unchanged = applyPatch(state, { schemaVersion: 1, operations: [], continuationSummary: "Still implementing." }, 20);
		expect(unchanged.items.goals.primary?.value).toBe("ship plugin");
		expect(unchanged.continuationSummary).toBe("Still implementing.");
	});

	test("merges deterministic file history", () => {
		let state = mergeFileHistory(
			createEmptyState(),
			{ read: ["a.ts", "b.ts"], written: ["b.ts"], edited: [] },
			20,
		);
		state = mergeFileHistory(state, { read: ["c.ts"], written: [], edited: ["a.ts"] }, 20);
		expect(state.items.workspace["files.read"]?.value).toEqual(["c.ts"]);
		expect(state.items.workspace["files.modified"]?.value).toEqual(["b.ts", "a.ts"]);
	});

	test("keeps the most recent file paths when history is bounded", () => {
		let state = mergeFileHistory(
			createEmptyState(),
			{ read: ["z-old.ts", "a-old.ts"], written: [], edited: [] },
			2,
		);
		state = mergeFileHistory(state, { read: ["m-new.ts"], written: [], edited: [] }, 2);
		expect(state.items.workspace["files.read"]?.value).toEqual(["a-old.ts", "m-new.ts"]);
	});

	test("rejects malformed canonical state loaded from persisted sessions", () => {
		const valid = createEmptyState();
		expect(isCanonicalState(valid)).toBe(true);

		const badItem = structuredClone(valid) as unknown as { items: { facts: Record<string, unknown> } };
		badItem.items.facts.release = { value: "v1", updatedAtRevision: 99 };
		expect(isCanonicalState(badItem)).toBe(false);

		const extraSection = structuredClone(valid) as unknown as { items: Record<string, unknown> };
		extraSection.items.secrets = {};
		expect(isCanonicalState(extraSection)).toBe(false);
	});
});

describe("model patch parser", () => {
	test("normalizes natural-language model keys without weakening validation", () => {
		expect(normalizeStateKey("bun test")).toBe("bun_test");
		expect(normalizeStateKey(" Update config (current) ")).toBe("update_config-current");
		expect(normalizeStateKey("Runtime.Port")).toBe("runtime.port");
		expect(() => normalizeStateKey("\u0000\u0001")).toThrow("Invalid state key");
	});

	test("bridges native fallback summaries but not StateCompact summaries", () => {
		expect(shouldBridgePreviousSummary("## Goal\nNative fallback state")).toBe(true);
		expect(shouldBridgePreviousSummary('<statecompact revision="3" schema="1" />')).toBe(false);
		expect(shouldBridgePreviousSummary(undefined)).toBe(false);
	});

	test("expands the compact set/delete wire format", () => {
		const patch = parseStatePatch(
			'{"schemaVersion":1,"set":{"facts":{"runtime.port":8080},"tasks":{"primary":"ship"}},"delete":{"blockers":["active"]},"continuationSummary":"Current."}',
			limits,
		);
		expect(patch.operations).toEqual([
			{ op: "set", section: "facts", key: "runtime.port", value: 8080, evidence: undefined },
			{ op: "set", section: "tasks", key: "primary", value: "ship", evidence: undefined },
			{ op: "delete", section: "blockers", key: "active", evidence: undefined },
		]);
	});

	test("accepts omitted empty set or delete maps", () => {
		expect(
			parseStatePatch('{"schemaVersion":1,"set":{"facts":{"release":"v2"}},"continuationSummary":"Current."}', limits)
				.operations,
		).toEqual([{ op: "set", section: "facts", key: "release", value: "v2", evidence: undefined }]);
		expect(parseStatePatch('{"schemaVersion":1,"delete":{"tasks":["primary"]}}', limits).operations).toEqual([
			{ op: "delete", section: "tasks", key: "primary", evidence: undefined },
		]);
	});

	test("accepts object-form deletion maps and ignores deterministic workspace keys", () => {
		const patch = parseStatePatch(
			JSON.stringify({
				schemaVersion: 1,
				delete: {
					tasks: { primary: true, secondary: "completed" },
					workspace: { "files.read": true, "files.modified": true },
				},
			}),
			limits,
		);
		expect(patch.operations).toEqual([
			{ op: "delete", section: "tasks", key: "primary", evidence: undefined },
			{ op: "delete", section: "tasks", key: "secondary", evidence: undefined },
		]);
	});

	test("resolves redundant set/delete conflicts in favor of the replacement value", () => {
		const patch = parseStatePatch(
			'{"schemaVersion":1,"set":{"facts":{"release":"v3"}},"delete":{"facts":["release"]}}',
			limits,
		);
		expect(patch.operations).toEqual([{ op: "set", section: "facts", key: "release", value: "v3", evidence: undefined }]);
	});

	test("unwraps leaked internal StateItem values and ignores fake deterministic file state", () => {
		const patch = parseStatePatch(
			JSON.stringify({
				schemaVersion: 1,
				set: {
					facts: {
						release: { value: "v3", evidence: "old", updatedAtRevision: 2 },
						"workspace.files.modified": {
							value: ["fake.ts"],
							updatedAtRevision: 2,
						},
					},
			},
			}),
			limits,
		);
		expect(patch.operations).toEqual([{ op: "set", section: "facts", key: "release", value: "v3", evidence: undefined }]);
	});

	test("extracts JSON after a thinking block and markdown fence", () => {
		const patch = parseStatePatch(
			'<think>I considered {several} things</think>\n```json\n{"schemaVersion":1,"operations":[],"continuationSummary":"Current."}\n```',
			limits,
		);
		expect(patch.continuationSummary).toBe("Current.");
	});

	test("rejects unknown sections", () => {
		expect(() =>
			parseStatePatch(
				'{"schemaVersion":1,"operations":[{"op":"set","section":"secrets","key":"token","value":"x"}]}',
				limits,
			),
		).toThrow("Unsupported state section");
	});

	test("rejects oversized values", () => {
		expect(() =>
			parseStatePatch(
				JSON.stringify({ schemaVersion: 1, operations: [{ op: "set", section: "facts", key: "blob", value: "x".repeat(3_000) }] }),
				limits,
			),
		).toThrow("Value too large");
	});
});
