export interface ReducerCallResult {
	stopReason: string;
	errorMessage?: string;
	output: string;
	usage?: unknown;
}

export interface ReducerRunResult<TPatch> {
	patch: TPatch;
	output: string;
	acceptedUsage?: unknown;
	attemptUsages: unknown[];
}

interface ReducerRunOptions<TPatch> {
	baseInput: string;
	signal: AbortSignal;
	safeInputLimit: number;
	estimateInputTokens: (text: string) => number;
	call: (requestText: string) => Promise<ReducerCallResult>;
	parseAndValidate: (output: string) => TPatch;
	onRetry?: (error: string) => void;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function repairInput(baseInput: string, rejectedOutput: string, rejection: string): string {
	return `${baseInput}\n\n<rejected_patch>\n${rejectedOutput}\n</rejected_patch>\nThe rejected patch failed validation: ${rejection}. Return one corrected JSON patch. Never repeat the validation error. Schema reminder: every section inside set MUST be an object keyed by stable keys, for example \"set\":{\"constraints\":{\"deploy.policy\":\"manual\"}}. Every section inside delete MUST be an array of stable keys, for example \"delete\":{\"tasks\":[\"old.task\"]}. Never put arrays directly under set sections.`;
}

export async function runReducerWithRepair<TPatch>(options: ReducerRunOptions<TPatch>): Promise<ReducerRunResult<TPatch>> {
	let requestText = options.baseInput;
	const attemptUsages: unknown[] = [];

	for (let attempt = 1; attempt <= 2; attempt += 1) {
		const estimatedTokens = options.estimateInputTokens(requestText);
		if (estimatedTokens > options.safeInputLimit) {
			throw new Error(
				`${attempt === 1 ? "Reducer" : "Repair"} input estimate ${estimatedTokens.toLocaleString()} exceeds safe ${options.safeInputLimit.toLocaleString()}`,
			);
		}

		const response = await options.call(requestText);
		attemptUsages.push(response.usage);
		try {
			if (response.stopReason === "error" || response.stopReason === "aborted") {
				throw new Error(response.errorMessage ?? `model stopped with ${response.stopReason}`);
			}
			if (!response.output) throw new Error("model returned no text");
			const patch = options.parseAndValidate(response.output);
			return { patch, output: response.output, acceptedUsage: response.usage, attemptUsages };
		} catch (error) {
			if (attempt === 2 || options.signal.aborted) throw error;
			const rejection = errorMessage(error);
			options.onRetry?.(rejection);
			requestText = repairInput(options.baseInput, response.output, rejection);
		}
	}

	throw new Error("reducer did not produce an accepted patch");
}
