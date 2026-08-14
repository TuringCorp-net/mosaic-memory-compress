# MosaicCompress for DeepSeek Harness — System Design

> Status: **prototype implemented & tested** (456 lines of source; typecheck +
> zone/replacement/pipeline test suites green against the real
> @deepseek-ai 0.1.0-rc.6 packages — no stubs) | Author: TuringCorp
> This module integrates the mosaic-compress forgetting-curve compression
> into DeepSeek Harness (DSH) as a pure plugin — **zero source changes to DSH**.
> 中文版：DESIGN.cn.md

## 1. Purpose

Bring the V1 mosaic semantics to DSH conversations:

- **Rounds 1-30 (raw zone)**: untouched, zero overhead
- **Rounds 30-50 (light zone)**: per-message dehydration — **message count unchanged**
- **Rounds 50+ (heavy zone)**: the ancient region folds into ONE bounded
  checkpoint that **never exceeds its cap** (incremental summary-of-summary)

## 2. How it works — the data flow

A DSH conversation is a **surface array** of nodes (user/assistant/tool
messages, model-visible order). The engine hooks the official pre-step event:

```
every agent pre-step → compactIfNeeded(agent, trigger, signal)
  │
  ├─ count = genuine user rounds on the surface
  │         (tool-result messages are role:'user' but source.kind==='tool' —
  │          they are NOT memory rounds; only real user turns count)
  │
  ├─ below threshold OR off-window  → return null  (zero cost, nothing happens)
  │
  ├─ LIGHT pass — per-node replacement on the middle zone:
  │     for each node in rounds [heavyStart, lightStart):
  │       distilled = LLM call per message (or rules mode, zero cost)
  │       session.append(same role, distilled content, {
  │         surfaceOp: { op: 'replace', start: seq, end: seq },  // 1:1
  │         sourceEventSeqs: [seq],
  │       })
  │     → count unchanged; original node goes to shadow (still in log, queryable)
  │
  └─ HEAVY pass — official compactRegion() transaction on the ancient zone:
        one checkpoint node replaces all nodes older than heavyStart
        → 60 rounds → 51 nodes (10 ancient → 1 checkpoint)
```

Position-is-age: zones are computed from surface positions (user rounds
counted from the tail). No round ledger is tracked. Pure zone math lives in
`src/zones.ts` (`zoneBoundaries(userCount, lightStart, heavyStart)`).

## 3. The four mechanism questions

### 3.1 Light: one LLM call per message (concurrency allowed)

Each light-zone message is distilled by **one small LLM call** (plain-text
output) — never one big batched call. Learned from a real-data failure:
batching 200+ messages in one call truncates the model output (silently
disabling all Light compression) and makes index alignment error-prone.

Calls are **independent and run concurrently** (library
semantics: `Promise.all` over the zone). **Any failure keeps the original
message verbatim** — compression never blocks the conversation (graceful
degradation, same as the library).

### 3.2 Heavy: never exceeds the cap — with OUR summarization

The heavy checkpoint is produced by **our** summarization, not DSH's:

- `summarize()` is overridden with the library's **dialogue-memory-compressor
  instruction**: role + output shape are specified, but *content selection is
  left to the model* (key decisions, preferences, unfinished action items,
  lessons — the model decides; ancient redundant material may be omitted).
  Routed through the conversation's own provider/model.
- Bounded by `maxTokens` (default 8192) — the cap is **never exceeded, by
  construction**.
- Incremental for free: the previous checkpoint node is inside the heavy
  range, so it gets re-summarized (summary-of-summary) — same property the
  library's recursive Heavy already has.

The natural fit with DSH: `compactRegion()` already implements "one range →
one summary node" with the durable transaction (locking, compaction/start|end
markers, stability checks, checkpoint framing). We reuse the transaction and
replace only the summarization content — zero DSH changes.

### 3.3 The replacement API (your mental model is correct)

Yes — the conversation is a message array, and one API call replaces **one
element** of it:

```ts
session.append('user/message', newMessage, {
  surfaceOp: { op: 'replace', start: seq, end: seq },  // start === end → one node
  sourceEventSeqs: [seq],
})
```

- The new content enters the model-visible array at that position.
- The original stays in the session log as **shadowed** history — never
  deleted, retrievable via session queries.
- All three surface roles are replaceable (user/assistant/tool-result), so a
  dehydrated replacement keeps its role and its tool pairing (`toolCallId`).

### 3.4 Anti-jitter: the counter decides

A simple counter decides whether to compress:

```ts
count = genuine user rounds on the surface
if (count < lightStart) return null                    // below threshold
if (count % lightWindow !== 0) return null             // off-window (jitter guard)
```

`lightWindow` (default 10) is the anti-jitter window: compression fires only
at window boundaries, so the conversation never churns. `context-overflow`
bypasses the window check and forces a run. Returning `null` means "nothing
happens this step" — the zero-cost path.

## 4. DSH extension points used

- `CompactionEngine` seam: `MosaicCompactionEngine extends
  BasicCompactionEngine`, overriding `compactIfNeeded` (trigger + zone
  passes) and `summarize` (heavy instruction). The official transaction
  machinery stays untouched.
- `session.append` + `surfaceOp: replace`: the key enabler for Light
  (per-node 1:1 replacement, §3.3). Public, validated API — same mechanism
  compaction-basic itself uses for checkpoints.

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
    lightMaxTokens: 1024
    maxTokens: 8192
```

## 6. Architecture boundaries

- **Originals are never deleted** — replacement shadows them; queryable.
- **The checkpoint node is the heavy summary**, bounded by `maxTokens`.
- **Light is per-message** (one LLM call per message, plain text, concurrent)
  — never batched; failures keep originals verbatim.
- Compaction markers (`compaction/start|end`) give the host durable records
  (≈ the library's `onCompress`).

## 7. Prototype status (verified 2026-08-14)

| Item | Status |
|---|---|
| `npm run typecheck` against real 0.1.0-rc.6 types | PASS |
| `zones.spec` — zone boundaries incl. boundary-equality cases | PASS |
| `smoke.spec` — single-node surface replacement on a real Session | PASS |
| `pipe.spec` — threshold/off-window null; 60-round seed → light distilled (20) + raw verbatim (30) + heavy fold 60 → 51; LLM failure → originals preserved | PASS |

Source: `src/index.ts` (435 lines) + `src/zones.ts` (21 lines) — 456 lines
total, same order as the library itself (<500). Tests: 156 lines.

### Known limitations / next steps

1. **`compactNow` (manual `/compact`) is still inherited** from
   BasicCompactionEngine — a manual trigger currently produces the official
   one-shot summary instead of the mosaic passes. Unifying it needs a
   standalone (owner-null) transaction variant.
2. Tool-result node replacement is type-legal but only user-node replacement
   was exercised on a real Session — validate a tool round in the harness.
3. **Not yet mounted in a real DSH profile** (disable `compaction-basic`,
   load this module, drive a long conversation end-to-end).


## 8. Risks and open questions

- **API deltas found during implementation** (vs the earlier source reading)
  do NOT affect the algorithm: (a) `SummarizationInput` /
  `summarizeWithLlm` are not public package exports → `summarize()` is
  implemented directly with `ctx.llm.stream` + `BlockAssembler`; (b) tool
  results are `role:'user'` messages with `source.kind==='tool'`, not a
  separate role → memory-round counting filters them; (c)
  `GenerateOptions.provider` is required and `StreamChunk` is a delta
  stream. The three-zone algorithm, position-is-age zones, Light 1:1
  replacement and Heavy bounded incrementality all stand unchanged.
- **Trigger granularity**: user-round count is the trigger unit, matching the
  library; tool rounds add nodes but no rounds (already documented).
- **KV-cache impact**: replacement events change the middle of the surface —
  same cost class as official compaction; not a new problem.

## 9. Out of scope

- Multi-tier granularity pyramid (theory in design docs; deliberately not
  implemented — engineering choice).
- MCP server form factor (possible future).
- Changes to DSH source code (this module deliberately ships zero).