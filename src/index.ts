import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serializeConversationForSummary } from "@oh-my-pi/pi-agent-core/compaction";
import { complete } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { redactSecrets } from "./redact.ts";
import { runReducerWithRepair } from "./reducer.ts";
import {
	applyPatch,
	assertPatchSafe,
	countItems,
	createEmptyState,
	findLatestPayload,
	mergeFileHistory,
	parseStatePatch,
	reconcileExplicitCompletionEvidence,
	reconcileExplicitClosures,
	reconcileExplicitVerificationEvidence,
	readPayload,
	reconcileFallbackAssignments,
	reconcileSpecificTestEvidence,
	renderCanonicalState,
	shouldBridgePreviousSummary,
} from "./state.ts";
import type { CanonicalState, StateCompactMetrics, StateCompactPayload } from "./types.ts";

const packageJson = JSON.parse(
	readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as { version?: unknown };
if (typeof packageJson.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageJson.version)) {
	throw new Error("StateCompact package.json contains an invalid version");
}
const PLUGIN_VERSION = packageJson.version;
const PRESERVE_KEY = "statecompact";
const STATUS_KEY = "statecompact";
const EXTRACTOR_PROMPT = readFileSync(fileURLToPath(new URL("./extractor.txt", import.meta.url)), "utf8");

function modelLabel(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

function extractText(response: { content: Array<{ type: string; text?: string }> }): string {
	return response.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
		.map(item => item.text)
		.join("\n")
		.trim();
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 3.5);
}

function buildReducerInput(options: {
	state: CanonicalState;
	transcript: string;
	legacyPreviousSummary?: string;
	customInstructions?: string;
}): string {
	const legacy = options.legacyPreviousSummary
		? `\n<fallback_summary_after_canonical_state>\nThis native fallback summary is newer than the existing canonical state. Merge every current state change from it before applying the new transcript.\n${redactSecrets(options.legacyPreviousSummary)}\n</fallback_summary_after_canonical_state>\n`
		: "";
	const focus = options.customInstructions
		? `\n<operator_focus>\n${redactSecrets(options.customInstructions)}\n</operator_focus>\n`
		: "";
	return [
		"<existing_canonical_state>",
		JSON.stringify(options.state),
		"</existing_canonical_state>",
		legacy,
		focus,
		"<new_transcript>",
		redactSecrets(options.transcript),
		"</new_transcript>",
	].join("\n");
}

function previousState(preparation: {
	previousPreserveData?: Record<string, unknown>;
}): CanonicalState {
	return readPayload(preparation.previousPreserveData?.[PRESERVE_KEY])?.state ?? createEmptyState();
}

function fallbackSummary(
	branchEntries: readonly unknown[],
	preparationSummary: string | undefined,
): string | undefined {
	for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
		const entry = branchEntries[index];
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const record = entry as Record<string, unknown>;
		if (record.type !== "compaction") continue;
		if (record.fromExtension === false && typeof record.summary === "string") return record.summary;
		return undefined;
	}
	return shouldBridgePreviousSummary(preparationSummary) ? preparationSummary : undefined;
}

function shortSummary(state: CanonicalState): string {
	const goal = state.items.goals.primary?.value;
	if (typeof goal === "string" && goal.trim()) return goal.trim().slice(0, 120);
	const firstLine = state.continuationSummary.split("\n").find(line => line.trim());
	return firstLine?.trim().slice(0, 120) || `StateCompact revision ${state.revision}`;
}

function currentPayload(ctx: ExtensionContext): StateCompactPayload | undefined {
	return findLatestPayload(ctx.sessionManager.getBranch(), PRESERVE_KEY);
}

function resolveReducerModel(ctx: ExtensionContext, selector: string | undefined) {
	return selector && selector !== "current" ? ctx.models.resolve(selector) : ctx.models.current();
}

export default function stateCompact(pi: ExtensionAPI) {
	pi.registerFlag("statecompact-model", {
		description: "Model selector for StateCompact (default: current session model)",
		type: "string",
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const flag = pi.getFlag("statecompact-model");
		let config;
		try {
			config = loadConfig(ctx.cwd, typeof flag === "string" ? flag : undefined);
		} catch (error) {
			ctx.ui.notify(`StateCompact config error; using native compaction: ${String(error)}`, "warning");
			return;
		}

		let model: ReturnType<typeof resolveReducerModel>;
		try {
			model = resolveReducerModel(ctx, config.model);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`StateCompact could not resolve model ${config.model ?? "current"}; using native compaction: ${message}`, "warning");
			return;
		}
		if (!model) {
			ctx.ui.notify(`StateCompact could not resolve model ${config.model ?? "current"}; using native compaction`, "warning");
			return;
		}

		const deadlineSignal = AbortSignal.timeout(config.timeoutMs);
		const callSignal = AbortSignal.any([event.signal, deadlineSignal]);
		let apiKey: string | undefined;
		try {
			apiKey = await ctx.modelRegistry.getApiKey(model, undefined, { signal: callSignal });
		} catch (error) {
			if (!event.signal.aborted) {
				const message = deadlineSignal.aborted
					? `credential lookup exceeded ${config.timeoutMs.toLocaleString()} ms deadline`
					: error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`StateCompact credential lookup failed; using native compaction: ${message}`, "warning");
				pi.logger.warn("StateCompact credential lookup failed", { message, model: modelLabel(model) });
			}
			return;
		}
		if (!apiKey) {
			ctx.ui.notify(`StateCompact has no credential for ${model.provider}; using native compaction`, "warning");
			return;
		}

		const messages = [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages];
		let transcript: string;
		let evidenceTranscript: string;
		let state: CanonicalState;
		let bridgedPreviousSummary: string | undefined;
		let reducerInput: string;
		try {
			// Reasoning is transient scratch: it bloats the reducer input and
			// leaks superseded speculation into the evidence reconcilers.
			const llmMessages = pi.pi.convertToLlm(messages).map(message => {
				if (!Array.isArray(message.content)) return message;
				const content = message.content.filter(block => block.type !== "thinking");
				return { ...message, content } as typeof message;
			});
			transcript = serializeConversationForSummary(llmMessages);
			// The evidence reconcilers trust only user statements and tool
			// results. Assistant text (including bare continuation blocks of
			// multi-paragraph messages) is analysis, not proof.
			evidenceTranscript = serializeConversationForSummary(
				llmMessages.filter(message => message.role !== "assistant"),
			);
			state = previousState(event.preparation);
			bridgedPreviousSummary = fallbackSummary(event.branchEntries, event.preparation.previousSummary);
			reducerInput = buildReducerInput({
				state,
				transcript,
				legacyPreviousSummary: bridgedPreviousSummary,
				customInstructions: event.customInstructions,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`StateCompact could not prepare reducer input; using native compaction: ${message}`, "warning");
			pi.logger.warn("StateCompact reducer preparation failed", { message, model: modelLabel(model) });
			return;
		}
		const estimatedInputTokens = estimateTokens(EXTRACTOR_PROMPT) + estimateTokens(reducerInput);
		const safeInputLimit = model.contextWindow
			? Math.floor(model.contextWindow * config.maxInputFraction) - config.maxOutputTokens
			: Number.POSITIVE_INFINITY;
		if (estimatedInputTokens > safeInputLimit) {
			ctx.ui.notify(
				`StateCompact input estimate ${estimatedInputTokens.toLocaleString()} exceeds safe ${safeInputLimit.toLocaleString()}; using native compaction`,
				"warning",
			);
			return;
		}

		const label = modelLabel(model);
		if (config.notify) {
			ctx.ui.notify(
				`StateCompact: reducing ${messages.length} messages (${event.preparation.tokensBefore.toLocaleString()} tokens) with ${label}`,
				"info",
			);
		}
		ctx.ui.setStatus(STATUS_KEY, `StateCompact · ${label}`);
		const startedAt = performance.now();

		try {
			const reducer = await runReducerWithRepair({
				baseInput: reducerInput,
				signal: callSignal,
				safeInputLimit,
				estimateInputTokens: text => estimateTokens(EXTRACTOR_PROMPT) + estimateTokens(text),
				call: async requestText => {
					const response = await complete(
						model,
						{
							systemPrompt: [EXTRACTOR_PROMPT],
							messages: [
								{
									role: "user",
									content: [{ type: "text", text: requestText }],
									timestamp: Date.now(),
								},
							],
						},
						{
							apiKey,
							maxTokens: config.maxOutputTokens,
							temperature: 0,
							disableReasoning: config.disableReasoning,
							signal: callSignal,
						},
					);
					return {
						stopReason: response.stopReason,
						errorMessage: response.errorMessage,
						output: extractText(response),
						usage: response.usage,
					};
				},
				parseAndValidate: output => {
					let patch = reconcileFallbackAssignments(
						parseStatePatch(output, config),
						bridgedPreviousSummary,
						transcript,
					);
					patch = reconcileSpecificTestEvidence(state, patch);
					patch = reconcileExplicitVerificationEvidence(patch, redactSecrets(evidenceTranscript));
					patch = reconcileExplicitCompletionEvidence(patch, redactSecrets(evidenceTranscript));
					// Deletions follow the same evidence rule as the evidence
					// reconcilers: an assistant claiming "done" without a user
					// statement or tool result must not close or delete state.
					patch = reconcileExplicitClosures(state, patch, evidenceTranscript);
					if (state.revision === 0 && patch.operations.length === 0 && !patch.continuationSummary) {
						throw new Error("initial state patch was empty");
					}
					assertPatchSafe(state, patch, {
						deletionEvidenceText: evidenceTranscript,
						bridgedPreviousSummary,
						newerTranscript: transcript,
					});
					return patch;
				},
				onRetry: message => {
					if (config.notify) ctx.ui.notify(`StateCompact patch rejected; retrying once: ${message}`, "warning");
				},
			});

			let nextState = applyPatch(state, reducer.patch, config.tombstoneLimit);
			nextState = mergeFileHistory(nextState, event.preparation.fileOps, config.fileHistoryLimit);
			const summary = renderCanonicalState(nextState);
			const metrics: StateCompactMetrics = {
				model: label,
				inputMessages: messages.length,
				transcriptChars: transcript.length,
				estimatedInputTokens,
				outputChars: reducer.output.length,
				durationMs: Math.round(performance.now() - startedAt),
				reducerAttempts: reducer.attemptUsages.length,
				attemptUsages: reducer.attemptUsages,
				bridgedPreviousSummary: bridgedPreviousSummary !== undefined,
				usage: reducer.acceptedUsage,
			};
			const payload: StateCompactPayload = { pluginVersion: PLUGIN_VERSION, state: nextState, metrics };

			if (config.notify) {
				ctx.ui.notify(
					`StateCompact r${nextState.revision}: ${countItems(nextState)} current items, ${summary.length.toLocaleString()} summary chars`,
					"info",
				);
			}

			return {
				compaction: {
					summary,
					shortSummary: shortSummary(nextState),
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details: {
						plugin: "statecompact",
						pluginVersion: PLUGIN_VERSION,
						model: label,
						readFiles: [...event.preparation.fileOps.read],
						modifiedFiles: [...event.preparation.fileOps.written, ...event.preparation.fileOps.edited],
					},
					preserveData: { [PRESERVE_KEY]: payload },
				},
			};
		} catch (error) {
			if (!event.signal.aborted) {
				const message = deadlineSignal.aborted
					? `reducer exceeded ${config.timeoutMs.toLocaleString()} ms deadline`
					: error instanceof Error
						? error.message
						: String(error);
				ctx.ui.notify(`StateCompact failed; using native compaction: ${message}`, "warning");
				pi.logger.warn("StateCompact compaction failed", { message, model: label });
			}
			return;
		} finally {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	});

	pi.registerCommand("state", {
		description: "Show the latest StateCompact canonical state",
		handler: async (_args, ctx) => {
			const payload = currentPayload(ctx);
			ctx.ui.notify(payload ? renderCanonicalState(payload.state) : "No StateCompact state yet. Run /statecompact.", "info");
		},
	});

	pi.registerCommand("statecompact", {
		description: "Force StateCompact compaction now",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			await ctx.compact(args.trim() || "Produce the canonical current state now.");
		},
	});

	pi.registerCommand("statecompact-debug", {
		description: "Show StateCompact state, tombstones and last-call metrics",
		handler: async (_args, ctx) => {
			const payload = currentPayload(ctx);
			ctx.ui.notify(payload ? JSON.stringify(payload, null, 2) : "No StateCompact payload yet.", "info");
		},
	});
}
