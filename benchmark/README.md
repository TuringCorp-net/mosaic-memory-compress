# MosaicCompress Benchmark

Deterministic mechanism simulation of the **real** `mosaicCompress` algorithm
with a rule-based pseudo-LLM. Zero LLM cost, fully reproducible (fixed seeds),
seconds to run.

## Method

The simulation exercises the actual library code
(`src/index.ts`) end to end. Only the `callLLM` function is replaced with a
**deterministic pseudo-LLM**, so everything measured here reflects the
algorithm's mechanism — not LLM quality:

1. **Conversation generator** builds realistic messages:
   - colloquial user turns + assistant replies (CJK, mixed with tool noise),
   - **15% tool-call rounds**: assistant issues `read_file` / `search_web`
     calls, followed by large tool payloads (code snippets, web content) —
     these are the token hogs of real conversations,
   - **30% of assistant replies carry `reasoning_content`** (DeepSeek-style),
   - a **planted fact** (`FACT-<id>`) every 20 rounds, trackable through the
     whole pipeline.
2. **Pseudo-LLM** (deterministic, seeded):
   - Light: keeps fact-bearing messages verbatim; distills tool payloads to
     60 chars and prose to 80 chars (a "perfect de-watering" compressor),
   - Heavy: collects every fact present in the heavy zone into a 2-message
     summary pair, bounded by a simulated `max_tokens` budget
     (`MAX_HEAVY_TOKENS = 1500`). This mirrors what a real model does when
     the summary would exceed its output limit: oldest facts fall off first.
3. **Token estimation**: CJK ≈ 1 token/char, ASCII ≈ 1 token/4 chars,
   `tool_calls` JSON at 0.3 × length.

### Parameters (knobs at the top of `simulate.ts`)

| Knob | Default | Meaning |
|---|---|---|
| `TOOL_ROUND_RATE` | 0.15 | fraction of rounds containing a tool call |
| `REASONING_RATE` | 0.3 | fraction of assistant replies carrying reasoning |
| `FACT_EVERY` | 20 | plant one fact every N rounds |
| `FACT_RETENTION` | 1.0 | pseudo-compressor fact retention (1 = perfect) |
| `MAX_HEAVY_TOKENS` | 1500 | simulated summary output budget (≈ LLM max_tokens) |

> The heavy budget is a **simulation parameter**, not an algorithm limit.
> The library itself only hard-limits the heavy zone to 2 messages; in the
> real world the summary size is bounded by the model's `max_tokens`.
> Future adaptive thresholds (Roadmap M1) should derive all zone budgets
> from the model's context-window size (e.g. summary ≈ 2-5% of the window).

## Results (2026-08-14, default parameters, fixed seeds)

| Rounds | msgs in | msgs out | tokens in | tokens out | ratio | facts kept |
|---|---:|---:|---:|---:|---:|---:|
| 100 | 234 | 120 | 9,451 | 4,835 | 48.8% | 5/5 (100%) |
| 500 | 1,162 | 122 | 47,177 | 5,571 | 88.2% | 25/25 (100%) |
| 1,000 | 2,310 | 122 | 91,869 | 5,508 | 94.0% | 47/50 (94%) |
| 5,000 | 11,500 | 120 | 457,484 | 5,709 | 98.8% | 50/250 (20%) |

Reproduce with:

```bash
npm run bench
```

## Findings

1. **Steady state holds.** Message count and estimated token usage become
   constant after round ~60 and stay constant at 5,000 rounds (tokens vary
   <5%). The steady count is `2 + heavyStart × msgsPerRound` — 102 for pure
   two-message rounds, ~120 here because 15% tool rounds add messages.
2. **The summary budget bounds information retention.** With a perfect
   compressor but a 1500-token summary budget, facts survive fully until the
   budget fills (≈ 45 facts), then the oldest fall off: 94% at 1,000 rounds,
   **20% at 5,000 rounds**. This is not an LLM-quality problem — it is the
   mechanism. Early details are only recoverable if the host archived the
   originals (the `onCompress` callback + the host's persistence layer).
3. **Compressed token mix**: assistant content dominates (~60%), tool
   payloads shrink to ~12% after Light compression — confirming that
   compressing tool results (P0-1 policy) is the biggest win.

## Analyzing your own conversations

```bash
npm run bench -- --file chat.json
```

`chat.json` is a JSON array of messages in the library's `Message` shape:

```json
[{"role": "system", "content": "..."},
 {"role": "user", "content": "..."},
 {"role": "assistant", "content": "..."},
 {"role": "assistant", "content": "...", "tool_calls": [{"id": "x", "type": "function", "function": {"name": "f", "arguments": "{}"}}]},
 {"role": "tool", "content": "...", "tool_call_id": "x"}]
```

The tool reports the original vs. compressed message count, estimated
tokens and the compression ratio. An example file is provided at
`benchmark/example-chat.json`.

## Limitations

- The pseudo-LLM is a **perfect** compressor (retains all facts it sees).
  Real models miss facts; a small-sample real-LLM spot check (planned) will
  calibrate `FACT_RETENTION` against reality.
- Token figures are **estimates**, not provider tokenizer counts.
- The sweep is synthetic; real conversations vary (message sizes, tool mix).
  Use `--file` mode for real data.
