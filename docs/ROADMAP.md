# MosaicCompress — Roadmap

> Last updated: 2026-08-14.

## Strategic Direction

MosaicCompress stays a small, focused library: message-level forgetting-curve
compression. DeepSeek Harness is the primary integration reference, but the
library remains host-agnostic.

## Milestone 1 — Context-Aware Adaptive Thresholds (next)

**Problem**: `lightStart` / `heavyStart` / `lightWindow` / `heavyWindow`
currently default to fixed heuristics (30 / 50 / 10 / 10) hand-tuned for a
typical mid-size context window. Real models expose very different context
budgets (128K / 256K / 1M), so the right thresholds depend on the model in
use and on how much of the window the current conversation occupies.

**Primary target**: DeepSeek V4's 1M-token context window — zone boundaries
should scale with the model's context size and observed usage ratio, so the
same library behaves sensibly from 128K-class models up to 1M-class ones.

**Direction**:
- Accept an optional token/usage signal from the host (e.g. current context
  usage ratio, or a token counter), and derive zone boundaries from it —
  e.g. raw zone ≈ fixed share of the window, light zone ≈ next share, heavy
  summary ≈ bounded budget.
- Keep the anti-jitter cadence (`R % window == 0`) unchanged — it is sound.
- Keep round-based distance as the default (rounds are a time proxy: older
  rounds = earlier exchanges, regardless of per-round verbosity; the
  distribution averages out over long conversations). Optionally accept a
  `distanceMetric: 'rounds' | 'tokens'` mode for hosts that want token-budget
  precision.
- Add usage statistics so thresholds can react to observed consumption.

**Dependencies**: a real-LLM benchmark (Milestone 3) that measures information
retention, because adaptive thresholds are only meaningful if we can measure
what they cost.

## Milestone 2 — On-Compress Original Payload Callback

**Problem**: compression is lossy by design; the original text must be
preservable by the HOST (database, log, or platform spill), not by this
library.

**Direction**: add an `onCompress` callback that receives the raw payload being
compressed (plus zone metadata), so hosts can archive originals and re-read
them later on demand in their own persistence layer (database, log, or
platform spill). MosaicCompress stays stateless; this is an interface for
the architecture boundary, not built-in storage.

## Milestone 3 — Real-LLM Information Retention Benchmark

**Direction**: script a realistic long conversation (≥100 rounds) → compress →
ask the model early-fact questions → measure retention. Also measure actual
token usage (not the assumed 200/800 tokens per round) to replace the
hypothetical efficiency table with measured numbers.

## Milestone 4 — Tool-Message Semantics

**Direction**: define explicit policy for messages carrying `tool_calls` /
`tool_call_id` / `reasoning_content`: skip them, strip, or compress content
while preserving pairing integrity for OpenAI-compatible downstream validation.
