# MosaicMemoryCompress — Roadmap

> Last updated: 2026-08-17.

## Strategic Direction

MosaicMemoryCompress stays a small, focused library: message-level forgetting-curve
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

## Milestone 2 — On-Compress Original Payload Callback ✅ (implemented 2026-08-14)

**Problem**: compression is lossy by design; the original text must be
preservable by the HOST (database, log, or platform spill), not by this
library.

**Direction**: add an `onCompress` callback that receives the raw payload being
compressed (plus zone metadata), so hosts can archive originals and re-read
them later on demand in their own persistence layer (database, log, or
platform spill). MosaicMemoryCompress stays stateless; this is an interface for
the architecture boundary, not built-in storage.

## Milestone 3 — Real-LLM Information Retention Benchmark ✅ (implemented)

**Direction**: script a realistic long conversation (≥100 rounds) → compress →
ask the model early-fact questions → measure retention. Also measure actual
token usage (not the assumed 200/800 tokens per round) to replace the
hypothetical efficiency table with measured numbers.

## Milestone 4 — Tool-Message Semantics ✅ (implemented 2026-08-16 — structural light truncates reasoning/arguments/results while preserving tool pairing)

**Direction**: define explicit policy for messages carrying `tool_calls` /
`tool_call_id` / `reasoning_content`: skip them, strip, or compress content
while preserving pairing integrity for OpenAI-compatible downstream validation.

## M5 (direction): cost tradeoff & reset-moment enhancement (v2 form)

**Cost model — field-verified 2026-09-06** (production session; supersedes the
2026-08-16 single-fold extrapolation of "~10× session cost"): in-place
compaction taxes prefix caches per window, and the tax is repaid within the
same window by the surface it frees:

- light pass (mid-surface 1:1 dewatering): prefix survives to the first
  replaced node (~97% next-request hit); one-time tax ≈ 80K tokens ≈
  $0.015-0.04 vs ≈ $0.20 of surface savings over the following ~30 requests
  (553K → 313K surface)
- heavy fold (head replacement): full prefix break by structure (requests
  are time-ordered, fold target is the head, prefix matches from token 0 —
  no layout avoids it); tax ≈ $0.046 + fold LLM ≈ $0.05 vs ≈ $0.27 of
  savings over the window (491K → 168K surface) → net ≈ +$0.15-0.17/window
- steady state: **cost goes DOWN, not up** — no 2× regime was observed in
  production; earlier multipliers described the heavyStart=30 single-shot era

**Value judgment**: the per-window tax buys **bounded surface + unbounded
dialogue** — official brief mode has zero tax but every reset turns the model
into a stranger who read a briefing. The irreplaceable value of
MosaicMemoryCompress (fresh recent memory, progressively fuzzier ancient
memory — the biological forgetting curve) is exactly what this tradeoff
preserves.

**Tunable knobs (parameterized balance)**:
- compression window N (default 30): tax amortization vs surface growth
- three-zone ratios (raw/light/heavy boundaries): continuous tuning of memory
  clarity vs context pressure
- future: reset-moment enhancement (below) can zero the tax entirely

**v2 form: reset-moment enhancement** (no continuous compaction — enhance
only at reset moments):
1. official brief compression folds all history into a briefing (existing behavior)
2. the **most recent 10-20 rounds** are refined with the existing structural
   truncation (reasoning/arguments/results truncated, user/assistant text kept as pairs)
3. new session injection order: [refined recent rounds + brief] — recent
   memory first

v2 benefits: zero cache cost (a new session's first miss is existing
behavior), better memory continuity than a pure brief, bounded surface, and
minimal implementation (reuses existing components).

**Status**: parameters finalized (10/40/30/30, 2026-09-05: decoupled light/heavy
cadences, light zone one window wide so the heavy fold always receives
dewatered input) — cost field-verified (2026-09-06) as net-negative per
window for long sessions, zero cost for short ones; continuous
compaction is the active mode, with re-deployment in progress. M2-M4 results
are fully preserved; M5 remains an evolution direction (the zero-tax
reset-moment form).
