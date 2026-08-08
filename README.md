# omp-statecompact

Canonical current-state compaction for [Oh My Pi](https://github.com/can1357/oh-my-pi).

Normal compaction asks a model to rewrite the conversation as prose. When a
port, branch, task, blocker, or policy changes several times, that prose can
keep both the current and obsolete values. StateCompact instead maintains one
validated current-state document: newer values replace older ones.

## Install

```bash
omp plugin install github:alesha-pro/omp-statecompact
```

Restart OMP, then verify the plugin:

```bash
omp plugin doctor
```

Tested with OMP 17.2.11 and Bun 1.3.14.

## How it works

1. OMP prepares the transcript region selected for compaction.
2. The configured reducer returns a small `set`/`delete` patch.
3. TypeScript validates size, conflicts, deletions, and collapse risk.
4. The patch updates one canonical state stored in OMP `preserveData`.
5. Deterministic file-operation history is merged into the result.

If the reducer times out, returns unsafe data, or fails validation,
StateCompact returns control to native OMP compaction. The last valid canonical
revision remains available for recovery on the next successful pass.

## Configure

By default StateCompact uses the current session model. To use the tested
low-cost OpenRouter reducer, create `.omp/statecompact.json` in your project:

```json
{
  "model": "openrouter/qwen/qwen3.7-flash",
  "timeoutMs": 25000
}
```

OMP supplies the provider credential from its model registry. StateCompact
does not require a second API-key setting.

Full configuration:

```json
{
  "model": "current",
  "maxOutputTokens": 4096,
  "timeoutMs": 25000,
  "disableReasoning": true,
  "maxInputFraction": 0.92,
  "maxOperations": 256,
  "maxValueChars": 12000,
  "tombstoneLimit": 128,
  "fileHistoryLimit": 200,
  "notify": true
}
```

Model selection order:

1. `--statecompact-model`
2. `STATECOMPACT_MODEL`
3. `.omp/statecompact.json`
4. current OMP model

The default 25-second reducer deadline stays below OMP 17.2.11's fixed
30-second extension-handler limit.

## Commands

- `/statecompact` forces compaction.
- `/state` shows the current canonical state.
- `/statecompact-debug` shows revision, tombstones, retries, usage, and timing.

## Privacy and safety

The selected transcript is sent to the configured reducer model. Common API
keys, bearer tokens, private keys, access keys, password assignments, and
credentialed URLs are redacted first, but regex redaction cannot cover every
secret format. Do not use a reducer provider that must not receive the session.

Reducer output is untrusted until schema, size, conflict, deletion-evidence,
and state-collapse checks pass. StateCompact does not keep a separate database
or log raw transcripts and reducer responses.

## Development

```bash
bun install
bun run check
bun run package:verify
```

The test suite covers replacement, A -> B -> A reverts, evidence-backed
deletion, tombstones, malformed persisted state, collapse defense, credential
redaction, bounded repair, fallback recovery, and file history.

Measured results and competitor comparisons are in [BENCHMARKS.md](BENCHMARKS.md).

## License

MIT
