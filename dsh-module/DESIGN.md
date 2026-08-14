# MosaicCompress for DeepSeek Harness — System Design

> Status: draft | Date: 2026-08-14 | Author: TuringCorp
> This module integrates the mosaic-compress forgetting-curve compression
> into DeepSeek Harness (DSH) as a pure plugin — **zero source changes to DSH**.

## 1. Purpose

Bring the V1 mosaic semantics to DSH conversations:

- **Rounds 1-30**: untouched, zero overhead (below threshold)
- **Rounds 30-50 (Light)**: per-message dehydration — **message count unchanged**
  - content distilled (filler removed, key intent kept)
  - tool *result* messages (large code / web / file payloads) compressed to their
    essential conclusion
  - `tool_calls` skeleton (function name + arguments) preserved untouched
  - `tool_call_id` preserved (pairing intact)
  - `reasoning_content` stripped
- **Rounds 50+ (Heavy)**: incremental heavy — the whole ancient region folds
  into one bounded checkpoint that **never exceeds its cap** (summaries of
  summaries, recursively re-summarized on every trigger)

The integration reuses the official DSH extension points and public session
APIs only.

## 2. DSH extension points used

### 2.1 `CompactionEngine` (capability seam)

`ctx.compaction` is a single-service seam. `@deepseek-ai/dsh-compaction-basic`
is the shipped backend; this module provides a **replacement backend**:

```ts
export abstract class CompactionEngine extends Service {
  abstract compactIfNeeded(agent, trigger, signal): Promise<CompactionResult | null>
  abstract compactNow(agent, signal, sourceCommandId?): Promise<CompactionResult | null>
  abstract compactRegion(start, end, agent, signal?): Promise<CompactionResult>
}
```

`BasicCompactionEngine` implements the durable transaction (locking,
replay-stability checks, `compaction/start|end` markers, checkpoint framing)
and exposes `summarize()` as the sole subclass customization hook. Our engine
subclasses it, so the hard parts (durable mutation, tool-pairing balance,
summary framing) stay official.

### 2.2 Surface replacement (the key enabler for Light)

Session events are append-only, but DSH supports **positional replacement**:
an appended `user/message` event can declare that it *replaces* an existing
surface span.

```ts
session.append('user/message', dehydratedMessage, {
  surfaceOp: { op: 'replace', start, end },  // start === end → single-node replace
  sourceEventSeqs: [/* seqs of replaced nodes */],
})
```

- `start === end` replaces **a single node** — this is what makes per-message
  dehydration possible with **count unchanged**
- **All three message roles are replaceable**: `SurfaceEventType` =
  `'user/message' | 'assistant/message' | 'tool/result'`, so a dehydrated
  replacement keeps its original role (user→user, assistant→assistant,
  tool→tool with `tool_call_id`)
- Replacement copies are **model-only**: the model sees the dehydrated version,
  the original stays in the log as shadowed history (queryable via
  `dsh-session-query`, never lost) — exactly the architecture boundary the
  library README documents
- This is the same mechanism compaction-basic itself uses for checkpoints
  (`region.ts`), so it is public, validated API — no source changes

## 3. Architecture

### 3.1 Repository layout

The module lives as a subdirectory of the mosaic-compress repository:

```
mosaic_compress/
├── src/            # the pure library (unchanged)
├── benchmark/      # simulation + real-LLM spot check (unchanged)
└── dsh-module/     # ← this integration
    ├── DESIGN.md
    ├── package.json        # @turingcorp/dsh-mosaic-compress
    ├── src/
    │   └── index.ts        # MosaicCompactionEngine + plugin entry
    └── tests/
```

### 3.2 Components

```
MosaicCompactionEngine extends BasicCompactionEngine
│
├─ override compactIfNeeded(agent, trigger, signal)
│   ├─ trigger check (anti-jitter; returns null otherwise — zero cost):
│   │     count ≥ lightStart && count % lightWindow === 0   → run Light
│   │     count ≥ heavyStart && count % heavyWindow === 0   → run Heavy
│   │     trigger === 'context-overflow' → force run regardless of window
│   ├─ lightPass()   → per-node surface replacements in the Light zone
│   │                  (executed FIRST; range [heavyStart, lightStart))
│   └─ heavyPass()   → this.compactRegion(heavyRange) (official transaction)
│
├─ override summarize(input, agent, signal)
│   └─ layered heavy-checkpoint template via ctx.llm (KV-cache friendly:
│      replay conversation prefix, append instruction as final user message)
│
└─ light distillation via ctx.llm (same semantics as the library's Light:
   LLM-driven dehydration; optional rules-only mode for zero-cost deployments)
```

### 3.3 Zone computation

Zones are computed from the **current surface node position** (position-is-age
model — no original-round ledger is tracked):

```
surface: [newest ... oldest]
  positions < lightStart          → raw (untouched)
  lightStart ≤ pos < heavyStart   → Light: per-node replacement (count unchanged)
  pos ≥ heavyStart                → Heavy: one checkpoint node
```

Consequence: after a Heavy pass collapses N nodes into 1, the node count
resets (e.g. 100 → ~51) and the next trigger fires ~9-10 rounds later —
trigger rhythm stays near-window, not exact-round. This is the intended
"position is age" semantics (the model forgets node counts, not true round
numbers), matching the library's theoretical foundation (design docs §8).

### 3.4 Heavy is incremental for free

On the next trigger, the previous checkpoint node is itself inside the heavy
range → `summarize()` re-summarizes it (**summary of a summary**). The
checkpoint text is bounded by `maxTokens`, so the heavy node size is constant
regardless of conversation length: **the cap is never exceeded, by
construction** — same property the library's recursive heavy already has.

## 4. Semantics mapping (V1 library ↔ DSH module)

| V1 concept | Library behavior | DSH module behavior |
|---|---|---|
| threshold / zero-cost | R < lightStart → return as-is | compactIfNeeded → null (no-op) |
| anti-jitter | R % window == 0 | same, on user-node count |
| Light (dehydrate, count unchanged) | rewrite message content in array | append replacement events 1:1 per node, original role preserved (user/assistant/tool) |
| tool result compression | content distilled, pairing kept | same via replacement; tool_calls skeleton kept |
| reasoning_content | stripped | stripped (removed from replacement content) |
| Heavy (incremental, bounded) | recursive summary pair | official compactRegion + bounded checkpoint |
| original payloads | host responsibility (onCompress) | shadowed in session log (queryable) |

## 5. Configuration

```yaml
# cordis.patch.yml (web profile overlay)
- id: compaction-basic
  disabled: true          # one ctx.compaction backend at a time

- id: mosaic-compact
  name: '@turingcorp/dsh-mosaic-compress'
  config:
    lightStart: 30
    lightWindow: 10
    heavyStart: 50
    heavyWindow: 10
    # summarization routing (falls back to the session's routed model)
    summarizationProvider: ''
    summarizationModel: ''
    maxTokens: 8192
```

Defaults mirror `DEFAULT_CONFIG` of the library. Hosts may also keep the
library's zones table extension in mind (documented in the design docs) —
not part of this module's default path.

## 6. Architecture boundaries

- **Originals are never deleted.** Replacement shadows them; `dsh-session-query`
  can retrieve shadowed events. No extra persistence needed in v1 of the module.
- **The checkpoint node is the heavy summary**; bounded by `maxTokens`.
- **Light distillation is per-message**: one small LLM call per message
  (plain-text output), NOT one big batched call. Learned from a real-data
  failure: batching 200+ messages in one call truncates the model output
  (silently disabling all Light compression) and makes cross-message index
  alignment error-prone. Per-message keeps input small, output structure-free
  and never truncates. An optional **rules-only Light mode** reduces model
  calls to zero for zero-cost deployments.
- Compaction markers (`compaction/start|end`) already give the host durable
  records of what happened (≈ the library's onCompress event).

## 7. Verification plan

1. **Unit**: dehydration rules — content distilled, tool result compressed,
   tool_calls skeleton untouched, reasoning stripped (port library tests).
2. **Integration (real DSH)**: drive a long synthetic conversation; at trigger
   points assert:
   - Light zone: node count unchanged, contents dehydrated, pairing intact
   - Heavy zone: one bounded checkpoint appears; repeated triggers keep it
     bounded (incremental)
   - raw zone untouched
3. **Fact retention**: reuse the benchmark FACT methodology on the folded
   surface after repeated triggers.
4. **Real-LLM check**: one real summarization pass (flash model) to validate
   the checkpoint template quality.

## 8. Risks and open questions

- **Append validation vs single tool-node replacement**: `tool/result` is a
  valid `SurfaceEventType`, so replacing a lone tool node is type-legal; the
  append validator's pairing checks must still accept it with `tool_call_id`
  intact. Validate in the prototype; fallback is replacing the whole round
  (user+assistant+tool) as a group — count still unchanged per round.
- **Concurrency/locking**: `compactIfNeeded` runs in the agent's pre-step
  context; confirm no interleaving with a concurrently running compaction
  (the engine's own marker logic already serializes heavy; light replacements
  must not run mid-heavy — prototype check).
- **KV-cache impact**: replacement events change the middle of the surface,
  which can invalidate part of the provider prefix cache — same cost class as
  official compaction; not a new problem.
- **Trigger granularity**: user-node count is the trigger unit, matching the
  library; message count may vary with tool rounds (already documented).

## 9. Out of scope

- Multi-tier granularity pyramid (theory documented in design docs; not
  implemented — engineering choice).
- MCP server form factor (possible future).
- Changes to DSH source code (this module deliberately ships zero).
