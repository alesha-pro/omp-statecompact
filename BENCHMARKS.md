# Benchmarks

Measured on 2026-08-08 with OMP 17.2.11 and Bun 1.3.14. StateCompact version
was 0.3.0. These are single cloud runs, not provider-wide p50 or p95 claims.

## What the benchmark tests

The fixture simulates a long, messy coding session. It tracks exact mutable
values such as ports, branches, owners, tasks, blockers, policies, and test
status. Across 120 turns the values are overwritten, some follow A -> B -> A
reverts, and obsolete archives plus stale assistant claims are reintroduced as
noise. The session is compacted three times.

After each compaction, deterministic code scans the model-visible context for:

- every exact current value;
- every exact obsolete value;
- visible context size;
- whether the requested extension or native fallback produced the result.

The final continuation must return the exact current values as JSON. No model
judge determines current or stale scores.

This test came from a [LabyrinthBench](https://github.com/owl-fleet/labyrinth-bench)
rev-2 result: append-only short memory reached a median 10/34 gates, while one
canonical slot per mutable value reached 34/34 and reduced median context by
72.0% versus full history.

## Main tournament

Session model: `openrouter/qwen/qwen3.6-35b-a3b`. StateCompact reducer:
`openrouter/qwen/qwen3.7-flash`.

| Arm | C3 current | C3 stale | C3 visible context | Final current | Final latency | Final reported cost |
|---|---:|---:|---:|---:|---:|---:|
| StateCompact 0.3.0 | 34/34 | 0/199 | 2,683 chars | 34/34 | 8.84 s | $0.008081 |
| CC Compact 0.1.0 | 34/34 | 0/199 | 10,211 chars | 34/34 | 8.88 s | $0.008251 |
| OMP Snapcompact | N/A in text | N/A in text | 2,008 text chars + 2 frames | 34/34 | 26.54 s | $0.013060 |
| Native OMP | 0/34 | current and stale dropped | 4,974 chars | 0/34 | 242.80 s | $0.017165 |

StateCompact and CC Compact tied on exact final recall. StateCompact used 3.8x
less visible text at C3. Its three separately recorded reducer calls cost
$0.000778041. CC Compact does not expose equivalent compaction-call usage, so
total end-to-end cost is not compared.

Snapcompact stores the compacted transcript in bitmap frames. The text scanner
therefore cannot score its checkpoint current/stale state. Its final multimodal
answer is scored normally. Snapcompact itself compacted locally in under one
second, but requires a vision-capable model. StateCompact's final recall call
was 3.0x faster and 1.62x cheaper in this run. This does not make StateCompact
universally faster or cheaper.

## Ten-compaction endurance

The endurance fixture has 160 turns, ten mutable fields, ten compactions, and
86 obsolete candidates by the final checkpoint.

| Arm | Current at C1-C10 | Stale at C1-C10 | C10 visible | Successful hook median | Native fallbacks | Final |
|---|---:|---:|---:|---:|---:|---:|
| StateCompact | 10/10 every time | 0 every time | 1,422 chars | 3.86 s | 1/10 | 10/10 |
| CC Compact | 10/10 every time | 9-19 every time | 6,010 chars | 20.93 s | 3/10 | 10/10 |

StateCompact's fifth reducer call exceeded its own 25-second deadline. It kept
revision 4 and allowed native fallback. The next compaction bridged that native
summary, recovered, and advanced to revision 5. The run ended at revision 9
without losing a current value or exposing a scored stale value.

CC Compact exceeded OMP's fixed 30-second extension limit three times. Its
seven successful extension summaries still retained obsolete values.

## Timeout and judge diagnostics

OMP 17.2.11 has a hard-coded 30-second generic extension-handler limit and no
public setting to change it. To distinguish timeout failure from compaction
quality, two diagnostics used an isolated copy of the OMP CLI with only that
limit raised to 300 seconds. The installed OMP CLI was not modified.

Slipstream 0.1.7 completed its first compaction in 36.30 seconds. It retained
0/34 current values and 11/68 stale values. Its internal LLM judge still scored
the summary 10/10 and accepted it with no missing facts or contradictions.
This is why the external benchmark uses exact-value scans.

CC Compact on DeepSeek timed out twice with the stock host limit. Under the
diagnostic limit, one completed checkpoint retained 34/34 current values but
also all 68/68 stale values in 15,141 visible characters.

Agentic Compaction 0.3.1 and Blackhole 0.4.5 each retained 4/34 current values
in the one-compaction screen and were not promoted to the paid full matrix.
Safe Compact 0.4.0 and Ultra Compact 1.3.0 were source-audited but not promoted
after stronger candidates failed or overlapped their summary/verification
designs.

## DeepSeek rerun

Session model: `openrouter/deepseek/deepseek-v4-flash`.

| Arm | Current at C1-C3 | Stale at C1-C3 | C3 visible | Median compaction | Final |
|---|---:|---:|---:|---:|---:|
| StateCompact | 34/34 every time | 0 every time | 2,683 chars | 1.69 s | 34/34 in 7.25 s |
| Native OMP | 34/34 every time | 0 every time | 6,809 chars | 28.43 s | 34/34 in 8.54 s |

An earlier DeepSeek run retained 199/199 stale markers, but the matched rerun
did not reproduce it. That older number is provider/model variance evidence,
not a deterministic native OMP claim. OpenRouter reported $0 for both DeepSeek
downstream calls, so no monetary comparison is made.

## Release verification

- 32 deterministic tests and TypeScript typecheck passed.
- The packed plugin installed into an isolated OMP environment and registered
  `/statecompact`, `/state`, and `/statecompact-debug`.
- Production dependencies passed a high-severity audit and did not install a
  second `pi-coding-agent` runtime.
- A packed-artifact dogfood session executed 20 real read/edit/write/bash tool
  calls, compacted twice, passed its project tests, and returned the exact final
  port, region, retry count, and test status.

## Claim boundary

The supported claim is: **StateCompact was the most effective text compaction
tested here for exact mutable state.** It tied the best final recall, produced
the smallest judge-free text state among successful text arms, and was the only
tested text plugin with zero stale values at all ten endurance checkpoints.

This is not an absolute fastest or cheapest claim, and it does not cover every
private or future plugin. Wider provider sampling and real long-running coding
sessions remain necessary.
