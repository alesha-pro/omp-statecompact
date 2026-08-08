export const STATE_SECTIONS = [
	"goals",
	"constraints",
	"facts",
	"decisions",
	"workspace",
	"tests",
	"tasks",
	"blockers",
] as const;

export type StateSection = (typeof STATE_SECTIONS)[number];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface StateItem {
	value: JsonValue;
	evidence?: string;
	updatedAtRevision: number;
}

export interface Tombstone {
	section: StateSection;
	key: string;
	evidence?: string;
	deletedAtRevision: number;
}

export type StateItems = Record<StateSection, Record<string, StateItem>>;

export interface CanonicalState {
	schemaVersion: 1;
	revision: number;
	continuationSummary: string;
	items: StateItems;
	tombstones: Tombstone[];
}

export interface SetOperation {
	op: "set";
	section: StateSection;
	key: string;
	value: JsonValue;
	evidence?: string;
}

export interface DeleteOperation {
	op: "delete";
	section: StateSection;
	key: string;
	evidence?: string;
}

export type PatchOperation = SetOperation | DeleteOperation;

export interface StatePatch {
	schemaVersion: 1;
	operations: PatchOperation[];
	continuationSummary?: string;
}

export interface StateCompactMetrics {
	model: string;
	inputMessages: number;
	transcriptChars: number;
	estimatedInputTokens: number;
	outputChars: number;
	durationMs: number;
	reducerAttempts?: number;
	attemptUsages?: unknown[];
	bridgedPreviousSummary?: boolean;
	usage?: unknown;
}

export interface StateCompactPayload {
	pluginVersion: string;
	state: CanonicalState;
	metrics: StateCompactMetrics;
}

export interface StateCompactConfig {
	model?: string;
	maxOutputTokens: number;
	timeoutMs: number;
	disableReasoning: boolean;
	maxInputFraction: number;
	maxOperations: number;
	maxValueChars: number;
	tombstoneLimit: number;
	fileHistoryLimit: number;
	notify: boolean;
}
