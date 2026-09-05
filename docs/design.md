# MosaicMemoryCompress — Stateless Dialogue Compression Based on Natural Forgetting Curve

> Version: v1.1.0 | Status: Stable | Last updated: 2026-08-17

---

## 1. Problem

In multi-turn LLM conversations, the context window grows linearly with each exchange. Traditional solutions:

- **Session management**: Force users to start "new conversations" → lose historical detail, high cognitive burden
- **Sliding window truncation**: Keep only the last N turns → early critical information lost
- **Summary compression**: Compress all history into one blob → dialogue structure destroyed, details untraceable

All three require users to understand and manage the concept of a "Session." For non-technical users (writers, creators, etc.), this is unnecessary friction.

---

## 2. Core Idea

> **Make Session invisible to users. Simulate human "natural forgetting curve" to enable a logically endless conversation.**

Human memory is not all-or-nothing. Recent events are remembered clearly; older events become fuzzy — but important events leave lasting impressions.

MosaicMemoryCompress simulates this process — light compression is structural
(rule-based, zero LLM), heavy compression delegates the summarizing judgment
to an LLM:

- **Recent dialogue**: Keep full original text (recent interactions need the most detail)
- **Slightly older**: Keep message structure, distill content ("de-watering") — Light Compress
- **Much older**: Merge multiple rounds into a narrative summary — Heavy Compress

The context window never overflows. The user never perceives the existence of a "Session."

---

## 3. How It Works

MosaicMemoryCompress is a **pure, stateless function**. Given a message array, it partitions it into three zones by recency:

```
Message array (R rounds total, from oldest to newest):

Round 1 ────→ Round (R-heavyStart)     │ Heavy zone → ALL → 2 msgs
Round (R-heavyStart+1) → (R-lightStart) │ Light zone → structural truncation, count unchanged
Round (R-lightStart+1) ──→ Round R      │ Raw zone  → keep as-is

Default boundaries (2026-09-05): lightStart=10, heavyStart=40 — 10 vivid
rounds, 20 dehydrating rounds, everything older folded.
```

**Anti-jitter**: Compression only fires when `R % lightWindow == 0` (Light) or `R % heavyWindow == 0` (Heavy). Light compression is pure structural truncation (milliseconds, zero LLM); only Heavy folds make one LLM summary call (~1-2s) at heavy-window boundaries.

### Light Compress

Per-message **structural truncation** — zero LLM calls (since 2026-08-16,
data-driven: real-surface token composition is reasoning 33% + tool-call
arguments 33% + tool results 24% vs. ~5% text; structural truncation of the
big structured payloads yields ~46% net surface savings vs 5.6% from 254
LLM calls):

- reasoning_content: head+tail 30 chars (field preserved; DeepSeek replays
  it on tool-call turns — truncation API-verified)
- tool_calls arguments: JSON shell preserved, string fields truncated to 120
- tool results: text head 30 + tail 30
- user/assistant text: untouched — stays fresh for the Heavy fold

Incremental: distilled messages carry a `_distilled` marker; re-triggers
skip them.

### Heavy Compress

Compress the entire Heavy zone into exactly 2 messages — a summary pair.

```
Before (50 rounds = 100 messages, possibly already light-compressed):
  [many messages spanning early worldbuilding, character decisions, plot discussions...]

After (2 messages):
  user:      "[Summary] 1) Worldbuilding: soft magic system established
              2) Characters: fall-arc protagonist, female lead, quiet and meticulous
              3) Narrative: fast-paced, subtext-rich, open endings
              4) TODO: supplement M1 commitment list item 5"
  assistant: "[Confirmed] Directions recorded: soft magic, fall arc, fast pacing, M1 TODO."
```

---

## 4. Configuration

```typescript
interface MosaicMemoryConfig {
  lightStart: number;   // Rounds to keep raw. Default 10
  lightWindow: number;  // Anti-jitter for Light. Default 30 (aligned with heavy)
  heavyStart: number;   // Rounds before this enter Heavy zone. Default 30
  heavyWindow: number;  // Anti-jitter for Heavy. Default 30
  callLLM?: (systemPrompt: string, userInput: string) => Promise<string>; // Heavy only; omit for light-only usage
}
```

---

## 5. Steady-State Message Count

With default parameters (`lightStart=10, lightWindow=30, heavyStart=40, heavyWindow=30`):

```
Heavy zone: 2 msgs   (1 user summary + 1 assistant confirmation)
Light zone: 40 msgs  (20 rounds × 2 — rounds R-heavyStart .. R-lightStart)
Raw zone:   20 msgs  (10 rounds × 2 — the most recent lightStart rounds)
─────────────────
Total:      62 msgs (31 user rounds) (+ 1 system prompt if present)
```

**This count is CONSTANT regardless of how many rounds the conversation has.** Whether at round 60 or round 15,000, the message count is always 62 (31 user rounds) for pure two-message rounds — in general `2 + heavyStart × messagesPerRound`. The exact value depends on the average number of messages per round (tool-call rounds add an assistant + tool message), but it never grows with R.

---

> Measured performance and information-retention numbers live in [benchmark/README.md](../benchmark/README.md) (deterministic simulation + real-LLM spot check). This design document intentionally does not repeat numbers.

## 6. Design Philosophy

1. **Data-driven light, LLM-judged heavy**: the light zone is structural
   truncation of the big structured payloads (reasoning/arguments/results —
   measured to be ~90% of surface tokens), preserving text verbatim; the
   heavy zone delegates summarization judgment to the LLM
2. **Preserve message skeleton**: Light Compress keeps the user/assistant alternation structure — causal chains remain traceable
3. **Natural forgetting, not violent truncation**: Older = fuzzier, newer = clearer
4. **Zero user awareness**: No Session concept to understand, no context window to manage
5. **Stateless & idempotent**: Same input always yields same output, regardless of call history

---

## 7. Usage

```typescript
import { mosaicMemoryCompress, type MosaicMemoryConfig, type Message } from 'mosaic-memory-compress';

const config: MosaicMemoryConfig = {
  lightStart: 10,
  lightWindow: 30,
  heavyStart: 40,
  heavyWindow: 30,
  callLLM: async (systemPrompt, userInput) => {
    // Wire to your own LLM provider
    const response = await yourLLM.chat({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userInput },
      ],
    });
    return response.content;
  },
};

// Call on every user message
const messages = loadConversationHistory();
const compressed = await mosaicMemoryCompress(messages, config);
// compressed is now ready to pass to your main LLM
```

---

## 8. Formal Model and the Engineering Choice

> This section is the **theoretical foundation** of the algorithm, not an
> implementation plan. It explains why MosaicMemoryCompress uses two levels
> (Light + Heavy) and why Heavy's recursive merge is mathematically sound.
> The exact multi-level model described below is deliberately NOT
> implemented — see 10.3 for the engineering rationale.

### 8.1 The exact model: position is age, nodes compress

Treat the message array as a sequence of **memory units**:

- **Each user node is one memory unit** (tool rounds add no user node, so the invariant holds).
- **Position is age**: counting from the tail (newest) toward the head (oldest), deeper position = more ancient.
- Compression fires once per anti-jitter window (`window`, default 10):
  - Each window boundary rolls exactly `window` fresh nodes into the compressible region,
  - so **any granularity g ≤ window completes within one window** (10 nodes at 2-to-1 → 5 nodes; 5-to-1 → 2 nodes; 10-to-1 → 1 node),
  - and granularities above `window` have no independent meaning — "merge more into one" is always achievable by repeating "window-to-1".
- **The deepest level is incremental Heavy**: each window merges the oldest `window` nodes into a summary of constant size; the summary never grows, the array oscillates and converges to a bound it **never exceeds** (a calculus-style limit).

Granularity tiers map to human memory:

| Memory stage | Human analogue | Granularity |
|---|---|---|
| seconds-minutes ago | crystal clear | raw (unchanged) |
| hours ago | growing fuzzy | g=1 (per-node dehydrate) |
| days-weeks ago | details lost | g=2 / g=5 (merge nodes) |
| months ago | only key points | g=10 / g=20 |
| years ago | mere impressions | incremental Heavy (never grows) |

The human brain is finite yet never "fills up" — the aged perception that
"time accelerates" is exactly the felt experience of old memories being
continuously compressed. This model is a discrete simulation of that.

### 8.2 V1's two levels = the 2-tier special case

- **Light (g=1)** = tier one of the exact model: per-node dehydration, node count unchanged.
- **Heavy (g=∞)** = the incremental-Heavy implementation: recursive merge
  (summaries of summaries); each window merges only the newly rolled-in
  `heavyWindow` rounds into the previous summary and always outputs 2
  messages — the "window-to-1 incremental" of 10.1, with `heavyWindow`
  substituted for the window.

V1's steady-state derivations (constant message count and token size) are
therefore direct consequences of the exact model.

### 8.3 Engineering choice: why two levels (Occam's razor)

Real human-AI conversation round counts:

| Scenario | Rounds | Two-level coverage |
|---|---|---|
| Simple errand | 3-5 | no trigger (<30), zero cost |
| Complex feature | 20-30 | boundary trigger |
| Large project | 40-70 | Light + Heavy once each |
| Thousand-round dialogue | does not exist | the multi-level model's only target |

The multi-level model (g = 1,2,5,10,20…) would pay — for a scenario that
does not occur — with higher implementation complexity and more LLM
compression calls (each merge is a model call; cost grows with tier count).
Benefit does not justify cost. **Two levels (V1) are the cost/effect
balance**: full coverage of the real distribution, minimal complexity,
fewest compression calls.

**Conclusion**: the exact model is the mathematical basis of V1; V1 is the
right engineering choice in the real distribution. If thousand-round
dialogues ever become real, the multi-level model remains available as a
configuration-level extension (a granularity table) without touching the
algorithm — but it is not implemented today.

### 8.4 Future: progressive forgetting tiers (theory, not implemented)

Structural truncation makes the light pass **zero-cost**, so the two-zone
simplification is no longer forced by LLM-call economics — it is a running
choice. A finer position-is-age ladder is available whenever needed, e.g.:

- rounds 20–30: keep first/last 200 lines of structural payloads
- rounds 30–40: keep first/last 100 lines
- rounds 40–50: keep first/last 30 lines

Each tier forgets more of the structured payload (reasoning, arguments,
results, injections) — content the model's reasoning progressively stops
using. User/assistant **text is never compressed** in any tier, so the
conversation's core meaning always survives; the Heavy zone then folds each
ancient region into a distilled-forever kernel, keeping the conversation
endlessly continuable.

V1 ships the two-zone scheme (light + heavy) and observes real-world effect
before any finer tiering.
### 8.5 Cost model: the cache-breakpoint tax (measured 2026-08-16, refined 2026-09-06)

On providers with automatic prefix caching (DeepSeek, OpenAI), ANY in-place
edit of sent history breaks the cache prefix — the first edited node onward
is a full miss (DeepSeek prices misses 30× hits). Measured on a real DSH
session: 99.7% → 4.2% hit rate on the compression request, recovering to
99.9% immediately after.

The tax is **per-window, not per-message**: one full-miss request every N
rounds, amortized ≈ surface×30/N per round. N=10 measured ~10× conversation
cost; N=20/50 halves/quarters it. This is a parameterized tradeoff — the tax
buys bounded surface and unbounded dialogue, and can be tuned to the host's
cost sensitivity. (Zero-tax alternative: reset-moment enhancement — see
ROADMAP M5.)

**Field measurement (2026-09-06, live DSH session 85cd44e7, light pass on a
55-round workflow conversation).** The heavy-fold numbers above describe the
ancient-zone fold; the LIGHT pass behaves differently and far cheaper:

- 706 mid-surface nodes replaced 1:1 (30 rounds dewatered) — surface dropped
  553K → 313K tokens (context usage 55% → 39%)
- The cache break is NOT total: prefix caching survives up to the first
  replaced node (~304K tokens still cache-hit on the next request, 97% of the
  new surface); the miss is only the replaced span and beyond: 79.8K tokens
  (79,986 − 221 baseline miss)
- One-time light tax at DeepSeek pricing: ≈ $0.015–0.04 (miss $0.28–0.56/M,
  hit 10–30× cheaper)
- Payback within the same 30-round window: each following request bills
  ~240K fewer surface tokens ≈ $0.0067/round saved → ≈ $0.20 per window —
  **~10× the tax**. The dewatered surface pays for the miss within a handful
  of rounds.

So the earlier ~1.8×-baseline estimate (165-round simulation, heavyStart=30,
single-shot fold) overstates the steady-state cost of the aligned design:
the light tax is one order of magnitude smaller than the surface savings it
buys, and the heavy fold happens once per 30 rounds with a bounded,
already-dewatered input.


## 9. Empirical Case Study: One Event, Three Memory Carriers

> A real experiment, anonymized (participants and topic are not reproduced);
> only the methodological conclusions are kept. The setup is reproducible —
> any "multi-round design discussion + two compression schemes" combination
> yields the same comparison.

**The event.** Two participants — a human designer and an AI assistant — spent
several rounds discussing *compression-granularity design*: merge ratios
(2-to-1, 5-to-1, 10-to-1), how each tier maps to human memory stages, and the
engineering conclusion to ship two levels while keeping finer tiers as a
configuration-level extension. The outcome was written into the design docs.

**The treatment.** A few rounds later, the same conversation was compressed
two ways:

- *Archival* (industry default): one threshold-triggered full summary,
  leaving only a structured brief;
- *Mnemonic* (this library): recent 30 rounds verbatim, older rounds distilled
  per message, ancient rounds merged into a constant-size summary.

**The results.**

| Carrier | Memory of the event | Form |
|---|---|---|
| Human designer | Tiers, mappings, process and conclusion — vivid and accurate | recent memory is verbatim by nature |
| AI after archival compression | one sentence only ("multi-tier exists but is deliberately not implemented") | tiers, process and data lost; design docs required to recover — "a new person who read a note" |
| AI after mnemonic compression | a dozen messages kept verbatim, including the designer's own words and experiment data | the discussion sat in the raw zone, never touched; no external reading needed |

**Conclusions.**

1. Humans remember recent events verbatim and keep only lessons and rules from
   ancient ones — direct behavioral evidence for the tier table in §8.1.
2. Archival compression preserves semantics (rules/conclusions) but loses
   events (process/detail), and the loss is invisible — the model cannot know
   what it has forgotten, nor compensate for it.
3. Mnemonic compression matches human behavior because the recent window is
   never touched: the AI can restate the discussion from context alone.
4. "Never compress the recent N rounds" is therefore not conservatism but the
   true source of conversational continuity — continuity rests on recent
   fidelity, not on the quality of any single summary.

## 10. License

MIT
