import { expect, test } from "bun:test";
import { redactSecrets } from "../src/redact.ts";

test("redacts common credentials before summarization", () => {
	// Assemble fake credentials at runtime so repository secret scanners do not
	// treat the redaction fixtures as live tokens.
	const openRouter = ["sk", "or", "v1", "abcdefghijklmnopqrstuvwxyz"].join("-");
	const bearer = ["eyJhbGciOiJIUzI1NiJ9", "payload", "signature"].join(".");
	const huggingFace = ["hf", "abcdefghijklmnopqrstuvwxyz"].join("_");
	const slack = ["xoxb", "12345678901234567890"].join("-");
	const aws = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
	const credentialedUrl = `https://${"buildbot"}:${"supersecret123"}@${"example.com"}/api`;
	const input = [
		`OPENROUTER_API_KEY=${openRouter}`,
		"token: abcdefghijklmnop",
		`Bearer ${bearer}`,
		huggingFace,
		slack,
		aws,
		credentialedUrl,
	].join("\n");
	const output = redactSecrets(input);
	expect(output).not.toContain(openRouter);
	expect(output).not.toContain("abcdefghijklmnop");
	expect(output).not.toContain(bearer);
	expect(output).not.toContain(huggingFace);
	expect(output).not.toContain(slack);
	expect(output).not.toContain(aws);
	expect(output).not.toContain("supersecret123");
	expect(output).toContain("[REDACTED");
});
