const SECRET_PATTERNS: Array<[RegExp, string]> = [
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]"],
	[/\bsk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{16,}\b/g, "[REDACTED API KEY]"],
	[/\b(?:ghp|github_pat|glpat)-?[A-Za-z0-9_-]{16,}\b/g, "[REDACTED TOKEN]"],
	[/\b(?:hf|npm)_[A-Za-z0-9_-]{16,}\b/g, "[REDACTED TOKEN]"],
	[/\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g, "[REDACTED TOKEN]"],
	[/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED AWS ACCESS KEY]"],
	[/\b(?:Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, "Bearer [REDACTED]"],
	[/\b((?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*)[^\s,;]{8,}/gi, "$1[REDACTED]"],
	[/\b(https?:\/\/[^\s/:@]+:)[^\s/@]+@/gi, "$1[REDACTED]@"],
];

export function redactSecrets(text: string): string {
	return SECRET_PATTERNS.reduce((redacted, [pattern, replacement]) => redacted.replace(pattern, replacement), text);
}
