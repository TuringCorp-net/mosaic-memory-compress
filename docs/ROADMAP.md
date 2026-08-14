# MosaicCompress — Roadmap

> Last updated: 2026-08-14. Milestones below reflect design reviews with the maintainer.

## Milestone 1 — Context-Aware Adaptive Thresholds (next)

**Problem**: `lightStart` / `heavyStart` / `lightWindow` / `heavyWindow` are hard-coded
guesses (30 / 50 / 10 / 10). Different LLMs have different context windows
(128K / 256K / 1M), and the right thresholds depend on how much of the window
the conversation currently occupies.

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
preservable by the HOST (database, log, DSH spill), not by this library.

**Direction**: add an `onCompress` callback that receives the raw payload being
compressed (plus zone metadata), so hosts can archive originals and re-read
them later on demand. MosaicCompress stays stateless; this is an interface
for the architecture boundary, not built-in storage.

## Milestone 3 — Real-LLM Information Retention Benchmark

**Direction**: script a realistic long conversation (≥100 rounds) → compress →
ask the model early-fact questions → measure retention. Also measure actual
token usage (not the assumed 200/800 tokens per round) to replace the
hypothetical efficiency table with measured numbers.

## Milestone 4 — Tool-Message Semantics

**Direction**: define explicit policy for messages carrying `tool_calls` /
`tool_call_id` / `reasoning_content`: skip them, strip, or compress content
while preserving pairing integrity for OpenAI-compatible downstream validation.
