# MosaicMemoryCompress for DeepSeek Harness — System Design

> MosaicMemoryCompress brings its natural forgetting-curve compression to DeepSeek
> Harness (DSH) as a pure plugin backend — **zero source changes to DSH**.
> 中文版：DESIGN.cn.md

## 1. Overview

Three zones, computed from the conversation surface:

- **Raw zone (recent N rounds, default 30)** — untouched, zero overhead
- **Light zone (next M rounds, default 20)** — structural truncation,
  message count unchanged
- **Heavy zone (older rounds)** — folded into ONE bounded checkpoint that
  never exceeds its cap (incremental summary-of-summary)

## 2. How it works

A DSH conversation is a surface array of nodes (user/assistant/tool messages,
model-visible order). The engine hooks the official pre-step event:

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
  │       truncated structurally (zero LLM, synchronous)
  │       session.append(same role, truncated content, {
  │         surfaceOp: { op: 'replace', start: seq, end: seq },  // 1:1
  │         sourceEventSeqs: [seq],
  │       })
  │     → count unchanged; original node goes to shadow (still in log, queryable)
  │
  └─ HEAVY pass — official compactRegion() transaction on the ancient zone:
        one checkpoint node replaces all nodes older than heavyStart
```

Position-is-age: zones are computed from surface positions (user rounds
counted from the tail). No round ledger is tracked. The pure zone math lives
in `src/zones.ts` (`zoneBoundaries(userCount, lightStart, heavyStart)`).

## 3. Mechanisms

### 3.1 Light: pure structural truncation

Since 2026-08-16 light is **structural truncation with zero LLM calls**,
driven by real-surface token measurements (reasoning 33% + tool-call
arguments 33% + tool results 24% vs. ~5% text; truncation nets ~46% surface
savings vs 5.6% from 254 LLM calls):

- reasoning blocks: head+tail 30 chars (field kept — DeepSeek replays it)
- tool-call arguments: JSON shell preserved, string fields truncated to 120
- tool-result blocks: inner text head 300 + tail 200
- plugin injections: truncated to 30
- user/assistant text: untouched (stays fresh for the Heavy fold)

Synchronous, deterministic, never fails; shadow-price (compaction/prune)
reporting unchanged.

### 3.2 Heavy: bounded checkpoint, custom summarization

The heavy checkpoint is produced by **our** summarization, not DSH's:

- `summarize()` is overridden with the library's dialogue-memory-compressor
  instruction: role and output shape are specified, but content selection is
  left to the model (key decisions, preferences, unfinished action items,
  lessons; ancient redundant material may be omitted).
- Bounded by `maxTokens` (default 8192) — the cap is never exceeded, by
  construction.
- Incremental: the previous checkpoint node is inside the heavy range, so it
  gets re-summarized (summary-of-summary).

`compactRegion()` already implements "one range → one summary node" with a
durable transaction (locking, compaction/start|end markers, stability checks,
checkpoint framing). The module reuses the transaction and replaces only the
summarization content.

### 3.3 The replacement API

The conversation is a message array; one append call replaces **one element**:

```ts
session.append('user/message', newMessage, {
  surfaceOp: { op: 'replace', start: seq, end: seq },  // start === end → one node
  sourceEventSeqs: [seq],
})
```

- The new content enters the model-visible array at that position.
- The original stays in the session log as shadowed history — never deleted,
  retrievable via session queries.
- All three surface roles are replaceable (user/assistant/tool-result), so a
  dehydrated replacement keeps its role and its tool pairing (`toolCallId`).

### 3.4 Anti-jitter: the counter decides

```ts
count = genuine user rounds on the surface   // incrementally maintained, O(1) read
if (count < lightStart) return null                    // below threshold
if (count % lightWindow !== 0) return null             // off-window (jitter guard)
```

The count is maintained **incrementally** from the session event stream
(session/event, append-only): a genuine user message (source.kind==='user')
increments it; the light pass's 1:1 replacements never change it; any range
fold (heavy checkpoint, third-party compaction) invalidates it and the next
use recomputes. New sessions and restarts initialize with one full scan.
The no-op path is therefore O(1) forever, independent of conversation
length, and the count always matches the live surface.

`lightWindow` (default 10) is the anti-jitter window: compression fires only
at window boundaries. `context-overflow` bypasses the window check and forces
a run. Returning `null` means nothing happens this step — the zero-cost path.

## 4. DSH extension points

- `CompactionEngine` seam: `MosaicMemoryCompactionEngine extends
  BasicCompactionEngine`, overriding `compactIfNeeded` (trigger + zone
  passes) and `summarize` (heavy instruction). The official transaction
  machinery stays untouched.
- `session.append` + `surfaceOp: replace`: the key enabler for Light
  (per-node 1:1 replacement, §3.3). Public, validated API — the same mechanism
  compaction-basic itself uses for checkpoints.

## 5. Configuration

```yaml
# cordis.patch.yml (web profile overlay)
- id: compaction-basic
  disabled: true          # one ctx.compaction backend at a time

- id: mosaic-memory-compact
  name: '@turingcorp/dsh-mosaic-memory-compress'
  config:
    lightStart: 10
    lightWindow: 30
    heavyStart: 30
    heavyWindow: 30
    maxTokens: 8192
```

## 6. Architecture boundaries

- **Originals are never deleted** — replacement shadows them; queryable.
- **The checkpoint node is the heavy summary**, bounded by `maxTokens`.
- **Light is structural truncation** (synchronous, deterministic, never fails)
  — zero LLM; failures keep originals verbatim.
- Compaction markers (`compaction/start|end`) give the host durable records
  of what happened.

## 7. Testing

Test suites run against the real @deepseek-ai packages (no stubs):

| Suite | Coverage |
|---|---|
| `zones.spec` | zone-boundary math, incl. boundary-equality cases |
| `smoke.spec` | single-node surface replacement on a real Session |
| `pipe.spec` | threshold/off-window no-ops; full 60-round pipeline (light distilled, raw verbatim, heavy fold 60 → 51 nodes); LLM failure keeps originals |

## 8. Scope

- Multi-tier granularity pyramid: theory in the design docs; deliberately not
  implemented (engineering choice).
- MCP server form factor: possible future.
- Changes to DSH source code: this module ships zero.
