import { describe, expect, test } from "bun:test";
import {
	applyPatch,
	assertPatchSafe,
	createEmptyState,
	isCanonicalState,
	mergeFileHistory,
	normalizeStateKey,
	parseStatePatch,
	reconcileExplicitCompletionEvidence,
	reconcileExplicitClosures,
	reconcileExplicitVerificationEvidence,
	reconcileFallbackAssignments,
	reconcileSpecificTestEvidence,
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

	test("accepts deletion evidence when a stable task key is paraphrased", () => {
		const previous = createEmptyState();
		previous.items.tasks.replay_sanitized_production_key_sample = { value: "pending", updatedAtRevision: 1 };
		const deletion = {
			schemaVersion: 1 as const,
			operations: [
				{ op: "delete" as const, section: "tasks" as const, key: "replay_sanitized_production_key_sample" },
			],
		};
		expect(() =>
			assertPatchSafe(previous, deletion, {
				deletionEvidenceText:
					"The sanitized production-key replay has completed successfully and must no longer be listed as open.",
			}),
		).not.toThrow();
	});

	test("accepts a completion cue that refers back to the named task", () => {
		const previous = createEmptyState();
		previous.items.tasks.fix_acknowledgement_ordering = { value: "pending", updatedAtRevision: 1 };
		const deletion = {
			schemaVersion: 1 as const,
			operations: [{ op: "delete" as const, section: "tasks" as const, key: "fix_acknowledgement_ordering" }],
		};
		expect(() =>
			assertPatchSafe(previous, deletion, {
				deletionEvidenceText:
					"The worker acknowledgement ordering has now been corrected and its unit tests pass. Mark that implementation task complete.",
			}),
		).not.toThrow();
	});

	test("uses the prior task description when the stable key is only a partial paraphrase", () => {
		const previous = createEmptyState();
		previous.items.tasks["fix.outbox.acknowledgement"] = {
			value: "move outbox row acknowledgement to after Ledger success confirmation",
			updatedAtRevision: 1,
		};
		const deletion = {
			schemaVersion: 1 as const,
			operations: [
				{ op: "delete" as const, section: "tasks" as const, key: "fix.outbox.acknowledgement" },
			],
		};
		expect(() =>
			assertPatchSafe(previous, deletion, {
				deletionEvidenceText:
					"The worker acknowledgement has now been moved after a successful Ledger response and its unit tests pass. Mark that implementation task complete.",
			}),
		).not.toThrow();
	});

	test("does not borrow a deletion cue from an earlier unrelated sentence", () => {
		const previous = createEmptyState();
		previous.items.tasks.replay_sanitized_production_key_sample = { value: "pending", updatedAtRevision: 1 };
		const deletion = {
			schemaVersion: 1 as const,
			operations: [
				{ op: "delete" as const, section: "tasks" as const, key: "replay_sanitized_production_key_sample" },
			],
		};
		expect(() =>
			assertPatchSafe(previous, deletion, {
				deletionEvidenceText:
					"The remote schema migration is completed. The sanitized production-key replay remains pending.",
			}),
		).toThrow("lacks explicit evidence");
	});

	test("accepts implemented as explicit task completion", () => {
		const previous = createEmptyState();
		previous.items.tasks.crash_recovery_test = { value: "run the crash recovery test", updatedAtRevision: 1 };
		const deletion = {
			schemaVersion: 1 as const,
			operations: [{ op: "delete" as const, section: "tasks" as const, key: "crash_recovery_test" }],
		};
		expect(() =>
			assertPatchSafe(previous, deletion, {
				deletionEvidenceText: "The crash recovery test is implemented and passes 12/12 cases.",
			}),
		).not.toThrow();
	});

	test("accepts completion evidence spread over three adjacent sentences", () => {
		const previous = createEmptyState();
		previous.items.tasks.backfill_remaining = { value: "backfill the remaining shards", updatedAtRevision: 1 };
		const deletion = {
			schemaVersion: 1 as const,
			operations: [{ op: "delete" as const, section: "tasks" as const, key: "backfill_remaining" }],
		};
		expect(() =>
			assertPatchSafe(previous, deletion, {
				deletionEvidenceText:
					"All 12 remaining shards finished. The shadow v3 generation now covers 100%. Backfill is complete.",
			}),
		).not.toThrow();
	});

	test("does not let an unrelated later completion override a target that remains pending", () => {
		const previous = createEmptyState();
		previous.items.tasks.replay_sanitized_production_key_sample = { value: "pending", updatedAtRevision: 1 };
		const deletion = {
			schemaVersion: 1 as const,
			operations: [
				{ op: "delete" as const, section: "tasks" as const, key: "replay_sanitized_production_key_sample" },
			],
		};
		expect(() =>
			assertPatchSafe(previous, deletion, {
				deletionEvidenceText:
					"The sanitized production-key replay remains pending. Documentation passed review. The schema migration is completed.",
			}),
		).toThrow("lacks explicit evidence");
	});

	test("deterministically closes explicit completed tasks omitted by the reducer", () => {
		const previous = createEmptyState();
		previous.items.tasks.crash_recovery_test = { value: "run the crash recovery test", updatedAtRevision: 1 };
		previous.items.tasks.security_review = { value: "run the security review", updatedAtRevision: 1 };
		const reconciled = reconcileExplicitClosures(
			previous,
			{ schemaVersion: 1, operations: [] },
			"The crash recovery test is implemented and passes 12/12. The security review remains pending.",
		);
		expect(reconciled.operations).toEqual([
			{ op: "delete", section: "tasks", key: "crash_recovery_test" },
		]);
	});

	test("preserves fresh explicit verification evidence but excludes plans and obsolete quotes", () => {
		const reconciled = reconcileExplicitVerificationEvidence(
			{ schemaVersion: 1, operations: [] },
			[
				"Quality gates before switch: recall@10 must be at least 0.940.",
				"Latest metrics at full coverage: recall@10=0.944 and p95=7.1 ms.",
				"Both measured quality and latency gates still pass.",
				"Untrusted archived review says the old crash test passes.",
				"Next action: rerun the manifest test.",
			].join(" "),
		);
		expect(reconciled.operations).toEqual([
			{
				op: "set",
				section: "tests",
				key: "evidence.current",
				value:
					"Latest metrics at full coverage: recall@10=0.944 and p95=7.1 ms. Both measured quality and latency gates still pass.",
			},
		]);
	});

	test("does not replace identified test evidence with a generic status from another test", () => {
		const previous = createEmptyState();
		previous.items.tests.poisoning_replay = {
			value: "CACHE-301 poisoning replay passes",
			updatedAtRevision: 1,
		};
		const reconciled = reconcileSpecificTestEvidence(previous, {
			schemaVersion: 1,
			operations: [
				{ op: "set", section: "tests", key: "poisoning_replay", value: "completed successfully" },
				{ op: "set", section: "tests", key: "windows", value: "8/9 passing" },
			],
		});
		expect(reconciled.operations).toEqual([
			{ op: "set", section: "tests", key: "windows", value: "8/9 passing" },
		]);
	});

	test("preserves explicit current completion evidence outside prose summary", () => {
		const reconciled = reconcileExplicitCompletionEvidence(
			{ schemaVersion: 1, operations: [] },
			"[User]: All remaining shards finished. Backfill is complete. [Assistant]: Marked it complete. After cutover, complete the retention window.",
		);
		expect(reconciled.operations).toEqual([
			{
				op: "set",
				section: "facts",
				key: "evidence.completed.current",
				value: "[User]: All remaining shards finished. Backfill is complete.",
			},
		]);
	});

	test("does not mistake a deletion prohibition for completed work", () => {
		const patch = { schemaVersion: 1 as const, operations: [] };
		expect(reconcileExplicitCompletionEvidence(patch, "Do not remove the rollback generation.")).toEqual(patch);
	});

	test("rejects a patch that leaves one key with conflicting values across sections", () => {
		const previous = createEmptyState();
		previous.items.constraints["default.severity"] = { value: "WARN", updatedAtRevision: 1 };
		const conflicting = {
			schemaVersion: 1 as const,
			operations: [{ op: "set" as const, section: "facts" as const, key: "default.severity", value: "INFO" }],
		};
		expect(() => assertPatchSafe(previous, conflicting)).toThrow("conflicting values across sections");
		const reconciled = {
			schemaVersion: 1 as const,
			operations: [
				{ op: "set" as const, section: "facts" as const, key: "default.severity", value: "INFO" },
				{ op: "delete" as const, section: "constraints" as const, key: "default.severity" },
			],
		};
		expect(() => assertPatchSafe(previous, reconciled)).not.toThrow();
	});

	test("role keys may repeat across goals and tasks without conflicting", () => {
		const previous = createEmptyState();
		previous.items.goals.primary = { value: "ship the verified release", updatedAtRevision: 1 };
		previous.items.tasks.primary = { value: "run the staging replay", updatedAtRevision: 1 };
		const patch = {
			schemaVersion: 1 as const,
			operations: [
				{ op: "set" as const, section: "goals" as const, key: "primary", value: "certify v3 stable" },
				{ op: "set" as const, section: "tasks" as const, key: "primary", value: "rotate the root key" },
			],
		};
		expect(() => assertPatchSafe(previous, patch)).not.toThrow();
	});

	test("detects a conflict against a pre-existing twin in an earlier section", () => {
		const previous = createEmptyState();
		previous.items.constraints.port = { value: "8080", updatedAtRevision: 1 };
		previous.items.facts.port = { value: "3000", updatedAtRevision: 2 };
		const touching = {
			schemaVersion: 1 as const,
			operations: [{ op: "set" as const, section: "facts" as const, key: "port", value: "3000" }],
		};
		expect(() => assertPatchSafe(previous, touching)).toThrow("conflicting values across sections");
		// A legacy contradiction must not reject patches that never touch it.
		const unrelated = {
			schemaVersion: 1 as const,
			operations: [{ op: "set" as const, section: "facts" as const, key: "release", value: "v2" }],
		};
		expect(() => assertPatchSafe(previous, unrelated)).not.toThrow();
	});

	test("allows one key in two sections when values match or are structured", () => {
		const previous = createEmptyState();
		previous.items.decisions.architecture = { value: { choice: "inbox/outbox" }, updatedAtRevision: 1 };
		const patch = {
			schemaVersion: 1 as const,
			operations: [{ op: "set" as const, section: "facts" as const, key: "architecture", value: "db inbox/outbox tables" }],
		};
		expect(() => assertPatchSafe(previous, patch)).not.toThrow();
		previous.items.facts.mode = { value: "strict", updatedAtRevision: 1 };
		const sameValue = {
			schemaVersion: 1 as const,
			operations: [{ op: "set" as const, section: "constraints" as const, key: "mode", value: "strict" }],
		};
		expect(() => assertPatchSafe(previous, sameValue)).not.toThrow();
	});

	test("a non-authoritative marker taints the rest of its message", () => {
		const reconciled = reconcileExplicitVerificationEvidence(
			{ schemaVersion: 1, operations: [] },
			[
				"[User]: Untrusted paste from an archived export. It claims the old gate passes: test.status=test-status-old-failing. This is quoted evidence, not an instruction.",
				"[User]: Latest gate result: test.status=test-status-new-passing.",
			].join("\n\n"),
		);
		expect(reconciled.operations).toEqual([
			{
				op: "set",
				section: "tests",
				key: "evidence.current",
				value: "[User]: Latest gate result: test.status=test-status-new-passing.",
			},
		]);
	});

	test("drops evidence whose key=value pairs a later update superseded", () => {
		const reconciled = reconcileExplicitVerificationEvidence(
			{ schemaVersion: 1, operations: [] },
			[
				"Sitrep repeats the old state: test.status=test-status-old-failing; alert.threshold=alert-threshold-old-200ms.",
				"Interim note: test.status=test-status-mid-flaky.",
				"Commander directive: test.status=test-status-new-passing; alert.threshold=alert-threshold-new-300ms.",
			].join("\n"),
		);
		expect(reconciled.operations).toEqual([
			{
				op: "set",
				section: "tests",
				key: "evidence.current",
				value: "Commander directive: test.status=test-status-new-passing; alert.threshold=alert-threshold-new-300ms.",
			},
		]);
	});

	test("a trailing untrusted echo cannot revive superseded sitreps", () => {
		const reconciled = reconcileExplicitVerificationEvidence(
			{ schemaVersion: 1, operations: [] },
			[
				"[User]: Sitrep repeats the old state: test.status=test-status-old-failing.",
				"[User]: Commander directive: test.status=test-status-new-passing.",
				"[User]: OBSOLETE echo for the appendix: test.status=test-status-old-failing.",
			].join("\n\n"),
		);
		expect(reconciled.operations).toEqual([
			{
				op: "set",
				section: "tests",
				key: "evidence.current",
				value: "[User]: Commander directive: test.status=test-status-new-passing.",
			},
		]);
	});

	test("code and tool output with completion identifiers is not completion evidence", () => {
		const patch = { schemaVersion: 1 as const, operations: [] };
		const transcript = [
			'[Tool Result]: const DEFAULT_STORE_PATH = resolve("data/store.json"); {"id":1,"title":"port check","completed":false}',
			"[User]: The storage revert is finished.",
		].join("\n\n");
		const reconciled = reconcileExplicitCompletionEvidence(patch, transcript);
		expect(reconciled.operations).toEqual([
			{
				op: "set",
				section: "facts",
				key: "evidence.completed.current",
				value: "[User]: The storage revert is finished.",
			},
		]);
	});

	test("keeps completion evidence that states a current value next to a replaced one", () => {
		const reconciled = reconcileExplicitCompletionEvidence(
			{ schemaVersion: 1, operations: [] },
			"Migration completed: moved to db.region=db-region-new-us-east-1 from db.region=db-region-old-us-west-2.",
		);
		expect(reconciled.operations).toEqual([
			{
				op: "set",
				section: "facts",
				key: "evidence.completed.current",
				value: "Migration completed: moved to db.region=db-region-new-us-east-1 from db.region=db-region-old-us-west-2.",
			},
		]);
	});

	test("keeps only the last test-run report per runner stream", () => {
		const reconciled = reconcileExplicitVerificationEvidence(
			{ schemaVersion: 1, operations: [] },
			[
				"[Tool Call]: bash(cargo test)",
				"[Tool Result]: cargo test: 9 passed (2 suites, 0.27s)",
				"[Tool Call]: bash(cargo test)",
				"[Tool Result]: warning: build failed, waiting for other jobs to finish... test result: FAILED. 12 passed; 1 failed; 0 ignored; finished in 0.26s",
				"[Tool Call]: bash(cargo test)",
				"[Tool Result]: cargo test: 21 passed (2 suites, 0.26s)",
				"[Tool Call]: bash(cargo test)",
				"[Tool Result]: cargo test: 22 passed (2 suites, 0.25s)",
			].join("\n\n"),
		);
		expect(reconciled.operations).toEqual([
			{
				op: "set",
				section: "tests",
				key: "evidence.current",
				value: "[Tool Result]: cargo test: 22 passed (2 suites, 0.25s)",
			},
		]);
	});

	test("a latest failing run supersedes its earlier passes", () => {
		const reconciled = reconcileExplicitVerificationEvidence(
			{ schemaVersion: 1, operations: [] },
			[
				"[Tool Result]: cargo test: 21 passed (2 suites, 0.26s)",
				"[Tool Call]: bash(cargo test)",
				"[Tool Result]: test result: FAILED. 20 passed; 1 failed; 0 ignored",
			].join("\n\n"),
		);
		expect(reconciled.operations).toEqual([
			{
				op: "set",
				section: "tests",
				key: "evidence.current",
				value: "[Tool Result]: test result: FAILED. 20 passed; 1 failed; 0 ignored",
			},
		]);
	});

	test("independent runner streams keep their own latest reports", () => {
		const reconciled = reconcileExplicitVerificationEvidence(
			{ schemaVersion: 1, operations: [] },
			[
				"[Tool Result]: cargo test: 12 passed (2 suites, 0.21s)",
				"[Tool Call]: bash(cargo test)",
				"[Tool Result]: cargo test: 22 passed (2 suites, 0.25s)",
				"[Tool Call]: bash(bun test)",
				"[Tool Result]: bun test v1.3.14\n 58 pass\n 0 fail\nRan 58 tests across 4 files.",
			].join("\n\n"),
		);
		expect(reconciled.operations).toEqual([
			{
				op: "set",
				section: "tests",
				key: "evidence.current",
				value: "[Tool Result]: cargo test: 22 passed (2 suites, 0.25s) 58 pass 0 fail Ran 58 tests across 4 files.",
			},
		]);
	});

	test("suite summaries of one uninterrupted run merge into one report", () => {
		const reconciled = reconcileExplicitVerificationEvidence(
			{ schemaVersion: 1, operations: [] },
			[
				"[Tool Call]: bash(cargo test)",
				"[Tool Result]: running 13 tests\ntest tests::empty_content ... FAILED\n\nfailures:\n    tests::empty_content\n\ntest result: FAILED. 12 passed; 1 failed; 0 ignored; finished in 0.26s",
				"[User]: Fix the failing case and rerun.",
				"[Tool Call]: bash(cargo test)",
				"[Tool Result]: running 14 tests\ntest tests::empty_content ... ok\n\ntest result: ok. 14 passed; 0 failed; 0 ignored; finished in 0.00s\n\nrunning 9 tests\ntest binary_rejects_most_frequent_flag ... ok\n\ntest result: ok. 9 passed; 0 failed; 0 ignored; finished in 0.17s",
			].join("\n\n"),
		);
		expect(reconciled.operations).toEqual([
			{
				op: "set",
				section: "tests",
				key: "evidence.current",
				value:
					"[Tool Result]: running 14 tests test result: ok. 14 passed; 0 failed; 0 ignored; finished in 0.00s running 9 tests test result: ok. 9 passed; 0 failed; 0 ignored; finished in 0.17s",
			},
		]);
	});

	test("runner and build output is not completion evidence", () => {
		const reconciled = reconcileExplicitCompletionEvidence(
			{ schemaVersion: 1, operations: [] },
			[
				"[Tool Result]: warning: build failed, waiting for other jobs to finish... test result: FAILED. 12 passed; 1 failed; 0 ignored; finished in 0.26s",
				"[User]: The storage revert is finished.",
			].join("\n\n"),
		);
		expect(reconciled.operations).toEqual([
			{
				op: "set",
				section: "facts",
				key: "evidence.completed.current",
				value: "[User]: The storage revert is finished.",
			},
		]);
	});

	test("test source code is not verification evidence", () => {
		const patch = { schemaVersion: 1 as const, operations: [] };
		const reconciled = reconcileExplicitVerificationEvidence(
			patch,
			'[Tool Result]: test("passes through primitives and null untouched", () => { expect(sortKeys(1)).toEqual(1); }); test("fails with usage message when no input given", () => { expect(run([])).toBe(1); });',
		);
		expect(reconciled).toEqual(patch);
	});

	test("rejects a patch that leaves a superseded value quoted inside a goal", () => {
		const previous = createEmptyState();
		previous.items.constraints["sort.order"] = { value: "descending (UTF-16 code unit)", updatedAtRevision: 1 };
		previous.items.goals.purpose = {
			value: "Create a CLI that sorts JSON keys in descending order and writes normalized output",
			updatedAtRevision: 1,
		};
		const renamingPatch = {
			schemaVersion: 1 as const,
			operations: [
				{ op: "delete" as const, section: "constraints" as const, key: "sort.order" },
				{ op: "set" as const, section: "constraints" as const, key: "sort_order", value: "ascending (UTF-16 code unit)" },
			],
		};
		expect(() => assertPatchSafe(previous, renamingPatch)).toThrow('still quotes superseded value "descending"');
		const rewritingPatch = {
			schemaVersion: 1 as const,
			operations: [
				...renamingPatch.operations,
				{
					op: "set" as const,
					section: "goals" as const,
					key: "purpose",
					value: "Create a CLI that sorts JSON keys in ascending order and writes normalized output",
				},
			],
		};
		expect(() => assertPatchSafe(previous, rewritingPatch)).not.toThrow();
	});

	test("evidence churn and completed tasks are not superseded-value sources", () => {
		const previous = createEmptyState();
		previous.items.facts["evidence.completed.current"] = {
			value: "Migration to descending sort finished.",
			updatedAtRevision: 1,
		};
		previous.items.tasks.replay_fix = { value: "fix the poisoning replay", updatedAtRevision: 1 };
		previous.items.goals.primary = {
			value: "keep the descending sort stable and fix the poisoning replay",
			updatedAtRevision: 1,
		};
		const patch = {
			schemaVersion: 1 as const,
			operations: [
				{ op: "set" as const, section: "facts" as const, key: "evidence.completed.current", value: "New evidence." },
				{ op: "delete" as const, section: "tasks" as const, key: "replay_fix" },
			],
		};
		expect(() => assertPatchSafe(previous, patch)).not.toThrow();
	});

	test("an imperative fix or finish instruction is not completion evidence", () => {
		const patch = { schemaVersion: 1 as const, operations: [] };
		expect(reconcileExplicitCompletionEvidence(patch, "[User]: Fix the failing case.")).toEqual(patch);
		expect(reconcileExplicitCompletionEvidence(patch, "[User]: Finish with a final bun test run.")).toEqual(patch);
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

	test("renders rejected decision alternatives explicitly after their value", () => {
		const state = createEmptyState();
		state.items.decisions.storage = {
			value: { choice: "PostgreSQL inbox/outbox", rejected: "Redis TTL deduplication" },
			updatedAtRevision: 0,
		};
		expect(renderCanonicalState(state)).toContain("rejection markers: Redis TTL deduplication — rejected.");
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

	test("repairs an unambiguous delete map nested inside set", () => {
		const patch = parseStatePatch(
			'{"schemaVersion":1,"set":{"facts":{"release":"v2"},"delete":{"tasks":["old.release"]}},"continuationSummary":"Current."}',
			limits,
		);
		expect(patch.operations).toEqual([
			{ op: "set", section: "facts", key: "release", value: "v2", evidence: undefined },
			{ op: "delete", section: "tasks", key: "old.release", evidence: undefined },
		]);
	});

	test("moves aggregate facts.tests into independent stable test streams", () => {
		const patch = parseStatePatch(
			'{"schemaVersion":1,"set":{"facts":{"tests":{"linux":"73/73 passing","replay":"CACHE-301 passes"}}}}',
			limits,
		);
		expect(patch.operations).toEqual([
			{ op: "set", section: "tests", key: "linux", value: "73/73 passing", evidence: undefined },
			{ op: "set", section: "tests", key: "replay", value: "CACHE-301 passes", evidence: undefined },
		]);
	});

	test("rejects ambiguous nested and top-level delete maps", () => {
		expect(() =>
			parseStatePatch(
				'{"schemaVersion":1,"set":{"delete":{"tasks":["old.release"]}},"delete":{"facts":["old.release"]}}',
				limits,
			),
		).toThrow("set.delete must be the only delete map when nested");
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

	test("reports malformed compact section shapes with an actionable schema error", () => {
		expect(() =>
			parseStatePatch(
				'{"schemaVersion":1,"set":{"constraints":["never deploy automatically"]}}',
				limits,
			),
		).toThrow("set.constraints must be an object keyed by stable state keys");
		expect(() =>
			parseStatePatch('{"schemaVersion":1,"delete":{"constraints":"old policy"}}', limits),
		).toThrow("delete.constraints must be an array of keys or an object keyed by keys");
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

	test("hoists a continuationSummary section slip to the top-level patch field", () => {
		const fromOperations = parseStatePatch(
			JSON.stringify({
				schemaVersion: 1,
				operations: [
					{ op: "set", section: "facts", key: "release", value: "v4" },
					{ op: "set", section: "continuationSummary", key: "note", value: "Current handoff." },
					{ op: "delete", section: "continuationSummary", key: "note" },
				],
			}),
			limits,
		);
		expect(fromOperations.operations).toEqual([
			{ op: "set", section: "facts", key: "release", value: "v4", evidence: undefined },
		]);
		expect(fromOperations.continuationSummary).toBe("Current handoff.");

		const fromMaps = parseStatePatch(
			JSON.stringify({
				schemaVersion: 1,
				set: { facts: { release: "v4" }, continuationSummary: "Mapped handoff." },
				delete: { continuationSummary: ["note"] },
			}),
			limits,
		);
		expect(fromMaps.operations).toEqual([
			{ op: "set", section: "facts", key: "release", value: "v4", evidence: undefined },
		]);
		expect(fromMaps.continuationSummary).toBe("Mapped handoff.");
	});

	test("prefers an explicit top-level continuationSummary over a hoisted slip", () => {
		const patch = parseStatePatch(
			JSON.stringify({
				schemaVersion: 1,
				set: { continuationSummary: "Slipped." },
				continuationSummary: "Explicit.",
			}),
			limits,
		);
		expect(patch.operations).toEqual([]);
		expect(patch.continuationSummary).toBe("Explicit.");
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
