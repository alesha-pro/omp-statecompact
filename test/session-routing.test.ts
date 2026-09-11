import { expect, mock, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const completeOptions: Record<string, unknown>[] = [];

mock.module("@oh-my-pi/pi-ai", () => ({
	complete: async (_model: unknown, _context: unknown, options: Record<string, unknown>) => {
		completeOptions.push(options);
		return {
			stopReason: "stop",
			content: [{ type: "text", text: '{"schemaVersion":1,"set":{"goals":{"primary":"prove session routing"}}}' }],
			usage: undefined,
		};
	},
}));

mock.module("@oh-my-pi/pi-agent-core/compaction", () => ({
	serializeConversationForSummary: () => "[User]: hello",
}));

test("reducer requests carry the OMP session id for session-routed providers", async () => {
	// Static import cannot work here: src/index.ts must load after the
	// mock.module registrations above, so the extension sees the stubbed
	// provider call instead of the real one.
	const { default: stateCompact } = await import("../src/index.ts");
	let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
	const pi = {
		registerFlag() {},
		getFlag: () => undefined,
		registerCommand() {},
		on(name: string, callback: (event: unknown, ctx: unknown) => Promise<unknown>) {
			if (name === "session_before_compact") handler = callback;
		},
		logger: { warn() {} },
		pi: { convertToLlm: (messages: unknown[]) => messages },
	} as unknown as ExtensionAPI;

	const model = { provider: "opencode-go", id: "deepseek-v4-flash", contextWindow: 200_000 };
	const ctx = {
		cwd: "/nonexistent-statecompact-session-routing",
		ui: { notify() {}, setStatus() {} },
		models: { current: () => model, resolve: () => model },
		modelRegistry: { getApiKey: async () => "test-key" },
		sessionManager: { getBranch: () => [], getSessionId: () => "session-1" },
	} as unknown as ExtensionContext;

	stateCompact(pi);
	expect(handler).toBeDefined();

	const event = {
		signal: new AbortController().signal,
		branchEntries: [],
		customInstructions: undefined,
		preparation: {
			messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 0 }],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 1_000,
			previousSummary: undefined,
			previousPreserveData: undefined,
			firstKeptEntryId: "entry-1",
			fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
			settings: {},
		},
	};

	await handler?.(event, ctx);

	expect(completeOptions).toHaveLength(1);
	expect(completeOptions[0]?.sessionId).toBe("session-1");
});
