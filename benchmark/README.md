# MosaicMemoryCompress Benchmark

Deterministic mechanism simulation of the **real** `mosaicMemoryCompress` algorithm
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
2. **Pseudo-LLM** (deterministic, seeded) — Heavy zone only, since the
   library's light pass is structural truncation (no LLM involvement):
   - Heavy: collects every fact present in the heavy zone into a 2-message
     summary pair, bounded by a simulated `max_tokens` budget
     (`DEFAULT_HEAVY_BUDGET = 16384`). This mirrors what a real model does
     when the summary would exceed its output limit: oldest facts fall off
     first.
3. **Token estimation**: CJK ≈ 1 token/char, ASCII ≈ 1 token/4 chars,
   `tool_calls` JSON at 0.3 × length.

### Parameters (knobs at the top of `simulate.ts`)

| Knob | Default | Meaning |
|---|---|---|
| `TOOL_ROUND_RATE` | 0.15 | fraction of rounds containing a tool call |
| `REASONING_RATE` | 0.3 | fraction of assistant replies carrying reasoning |
| `FACT_EVERY` | 20 | plant one fact every N rounds |
| `FACT_RETENTION` | 1.0 | pseudo-compressor fact retention (1 = perfect) |
| `DEFAULT_HEAVY_BUDGET` | 16384 | simulated summary output budget (≈ LLM max_tokens) |
| `BUDGET_SWEEP` | [2K…128K] | sensitivity sweep values for the tradeoff table |

> The heavy budget is a **simulation parameter**, not an algorithm limit.
> The library itself only hard-limits the heavy zone to 2 messages; in the
> real world the summary size is bounded by the model's `max_tokens`.
> Real output windows today: DeepSeek V4 up to **384K**, Claude/Gemini ~64K,
> GPT 16-64K — 16K is a conservative default for a *summary* budget.
> Future adaptive thresholds (Roadmap M1) should derive all zone budgets
> from the model's context-window size.

## Results (2026-08-14, default parameters — heavy budget 16K — fixed seeds)

| Rounds | msgs in | msgs out | tokens in | tokens out | ratio | facts kept |
|---|---:|---:|---:|---:|---:|---:|
| 100 | 234 | 120 | 9,451 | 4,472 | 52.7% | 5/5 (100%) |
| 500 | 1,162 | 122 | 47,177 | 5,104 | 89.2% | 25/25 (100%) |
| 1,000 | 2,310 | 122 | 91,869 | 5,307 | 94.2% | 50/50 (100%) |
| 5,000 | 11,500 | 120 | 457,484 | 9,805 | 97.9% | 250/250 (100%) |

![Context growth: uncompressed vs MosaicMemoryCompress (log scale)](chart.svg)

Reproduce with:

```bash
npm run bench
```

## Findings

1. **Steady state holds.** Message count becomes constant after round ~60 and
   stays constant at 20,000 rounds. Token usage rises only while the summary
   budget is unsaturated, then **freezes at the budget ceiling** — see
   finding 2. The steady count is `2 + heavyStart × msgsPerRound` — 102 for
   pure two-message rounds, ~120 here because 15% tool rounds add messages.
2. **The summary budget bounds retention — in two phases.** Before the budget
   fills, facts survive 100%; after it fills, the oldest fall off and the
   summary size is capped (verified in a one-off 20,000-round run). Capacity ≈ `budget / tokens-per-fact`
   (16K ≈ 487 facts at ~28 tok/fact in this generator). This is not an
   LLM-quality problem — it is the mechanism. Early details are only
   recoverable if the host archived the originals (the `onCompress`
   callback + the host's persistence layer).
3. **Budget sensitivity** (1000 / 5000 rounds):

   | budget | 1000r kept | 5000r kept | 5000r tokens out | 5000r ratio |
   |---|---|---:|---:|---:|
   | 2K | 100% | 26.4% | 5,745 | 98.7% |
   | 8K | 100% | 100% | 9,280 | 98.0% |
   | 16K | 100% | 100% | 9,805 | 97.9% |
   | 32K | 100% | 100% | 9,805 | 97.9% |
   | 128K | 100% | 100% | 9,805 | 97.9% |

   Raising the budget from the original 1.5K to 8-16K is **pure win**:
   retention 20% → 100% for ~1.7× steady tokens. Beyond the saturation
   point, larger budgets buy nothing until facts outgrow them. The
   budget-to-window ratio (e.g. 16K vs 128K/1M context) is exactly what
   Roadmap M1's adaptive thresholds should decide.
4. **Compressed token mix** (after the Light path actually distills): the
   raw zone's original user/assistant text dominates (~60%), assistant
   prose shrinks to ~33%, tool payloads to ~6-10% — confirming that
   compressing tool results and older prose is where the win is.

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


## Real-LLM Spot Check (layer 3)

The pseudo-LLM above is a *perfect* compressor. To see what a real model
does, `benchmark/real-llm-check.ts` runs the same pipeline with a **real
DeepSeek V4 Flash** as `callLLM` (one Light + one Heavy call, <$0.01):

```bash
DEEPSEEK_API_KEY=sk-... npm run bench:real      # env var, model override via DEEPSEEK_MODEL
```

It generates the same 100-round synthetic conversation (241 messages,
5 planted facts, tool calls, reasoning), compresses it with the real model,
and reports retention, structure integrity and API usage.

### Results (2026-08-14, deepseek-v4-flash)

| metric | result |
|---|---|
| compression ratio | **53.8%** (8,509 → 3,935 est. tokens; 241 → 121 msgs) |
| fact retention | **5/5 (100%)** — no planted fact lost |
| tool pairing | intact (9/9) |
| API cost | 8.5K tokens (4.8K prompt + 3.7K completion) |
| wall time | ~25 s |

**Calibration**: the real model matched the perfect pseudo-LLM (simulated
100-round ratio 52.7% vs real 53.8%; facts 100% in both), so
`FACT_RETENTION = 1.0` (or a conservative 0.95) stays a fair default for
long-range extrapolation.

## Limitations

- The pseudo-LLM is a **perfect** compressor (retains all facts it sees).
  The layer-3 spot check above measured a real model at 5/5 — but that is one
  sample; rerun `npm run bench:real` with your own conversations for more.
- Token figures are **estimates**, not provider tokenizer counts.
- The sweep is synthetic; real conversations vary (message sizes, tool mix).
  Use `--file` mode for real data.