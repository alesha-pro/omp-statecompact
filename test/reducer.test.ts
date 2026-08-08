import { expect, test } from "bun:test";
import { runReducerWithRepair } from "../src/reducer.ts";

test("repairs one rejected patch and records both usages", async () => {
	const requests: string[] = [];
	let calls = 0;
	const result = await runReducerWithRepair({
		baseInput: "state and transcript",
		signal: new AbortController().signal,
		safeInputLimit: 1_000,
		estimateInputTokens: text => text.length,
		call: async request => {
			requests.push(request);
			calls += 1;
			return calls === 1
				? { stopReason: "stop", output: "bad", usage: { tokens: 10 } }
				: { stopReason: "stop", output: "good", usage: { tokens: 12 } };
		},
		parseAndValidate: output => {
			if (output === "bad") throw new Error("conflicting keys");
			return { accepted: output };
		},
	});

	expect(result.patch).toEqual({ accepted: "good" });
	expect(result.attemptUsages).toEqual([{ tokens: 10 }, { tokens: 12 }]);
	expect(requests[1]).toContain("conflicting keys");
	expect(requests[1]).toContain("bad");
});

test("fails after the bounded second rejection", async () => {
	let calls = 0;
	await expect(
		runReducerWithRepair({
			baseInput: "input",
			signal: new AbortController().signal,
			safeInputLimit: 1_000,
			estimateInputTokens: text => text.length,
			call: async () => {
				calls += 1;
				return { stopReason: "stop", output: "bad" };
			},
			parseAndValidate: () => {
				throw new Error("still invalid");
			},
		}),
	).rejects.toThrow("still invalid");
	expect(calls).toBe(2);
});

test("does not send a repair that would exceed the model budget", async () => {
	let calls = 0;
	await expect(
		runReducerWithRepair({
			baseInput: "short",
			signal: new AbortController().signal,
			safeInputLimit: 100,
			estimateInputTokens: text => text.length,
			call: async () => {
				calls += 1;
				return { stopReason: "stop", output: "x".repeat(100) };
			},
			parseAndValidate: () => {
				throw new Error("invalid");
			},
		}),
	).rejects.toThrow("Repair input estimate");
	expect(calls).toBe(1);
});
