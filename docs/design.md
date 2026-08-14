# MosaicCompress — Stateless Dialogue Compression Based on Natural Forgetting Curve

> Version: v1.0.0 | Status: Stable | Last updated: 2026-06-08

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

MosaicCompress uses an LLM to simulate this process:

- **Recent dialogue**: Keep full original text (recent interactions need the most detail)
- **Slightly older**: Keep message structure, distill content ("de-watering") — Light Compress
- **Much older**: Merge multiple rounds into a narrative summary — Heavy Compress

The context window never overflows. The user never perceives the existence of a "Session."

---

## 3. How It Works

MosaicCompress is a **pure, stateless function**. Given a message array, it partitions it into three zones by recency:

```
Message array (R rounds total, from oldest to newest):

Round 1 ────→ Round (R-heavyStart)     │ Heavy zone → ALL → 2 msgs
Round (R-heavyStart+1) → (R-lightStart) │ Light zone → distill each, count unchanged
Round (R-lightStart+1) ──→ Round R      │ Raw zone  → keep as-is
```

**Anti-jitter**: Compression only fires when `R % lightWindow == 0` (Light) or `R % heavyWindow == 0` (Heavy). Typical configuration triggers every 10 rounds, so users experience a ~1-2 second delay every 10 turns — imperceptible in normal conversation flow.

### Light Compress

Distill each message independently — roles, order, and count are preserved.

```
Before (2 messages):
  user:      "I wanted to discuss the worldbuilding setup, I'm thinking the magic system
              could be something like..." (200+ words)
  assistant: "I understand your ideas. Based on your description, the magic system should
              adopt soft magic principles..." (800+ words)

After (2 messages, same roles, same order):
  user:      "Discussing magic system design, leaning toward soft magic" (~15 words)
  assistant: "Confirmed soft magic: rules vague but costs clear. Advised against hard
              magic-science approach" (~20 words)
```

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
interface MosaicConfig {
  lightStart: number;   // Rounds to keep raw. Default 30
  lightWindow: number;  // Anti-jitter for Light Compress. Default 10
  heavyStart: number;   // Rounds before this enter Heavy zone. Default 50
  heavyWindow: number;  // Anti-jitter for Heavy Compress. Default 10
  callLLM: (systemPrompt: string, userInput: string) => Promise<string>;
}
```

---

## 5. Steady-State Message Count

With default parameters (`lightStart=30, lightWindow=10, heavyStart=50, heavyWindow=10`):

```
Heavy zone: 2 msgs   (1 user summary + 1 assistant confirmation)
Light zone: 40 msgs  (20 rounds × 2 — rounds R-heavyStart .. R-lightStart)
Raw zone:   60 msgs  (30 rounds × 2 — the most recent lightStart rounds)
─────────────────
Total:      102 msgs (+ 1 system prompt if present)
```

**This count is CONSTANT regardless of how many rounds the conversation has.** Whether at round 60 or round 15,000, the message count is always 102 for pure two-message rounds — in general `2 + heavyStart × messagesPerRound`. The exact value depends on the average number of messages per round (tool-call rounds add an assistant + tool message), but it never grows with R.

---

## 6. Efficiency

| Rounds | Uncompressed | Compressed | Reduction |
|--------|-------------|-----------|-----------|
| 50 | 50,000 tokens | 33,700 tokens | 32.6% |
| 100 | 100,000 tokens | 33,700 tokens | 66.3% |
| 500 | 500,000 tokens | 33,700 tokens | 93.3% |
| 1,000 | 1,000,000 tokens | 33,700 tokens | 96.6% |
| 15,000 | 15,000,000 tokens | 33,700 tokens | 99.8% |

From round 60 onward, the compressed token count is **completely constant**. The compression ratio automatically approaches 100% as the conversation continues. The context window never overflows.

---

## 7. Design Philosophy

1. **Trust the LLM's judgment**: No rule-based truncation, no TF-IDF scoring. The LLM decides what's important
2. **Preserve message skeleton**: Light Compress keeps the user/assistant alternation structure — causal chains remain traceable
3. **Natural forgetting, not violent truncation**: Older = fuzzier, newer = clearer
4. **Zero user awareness**: No Session concept to understand, no context window to manage
5. **Stateless & idempotent**: Same input always yields same output, regardless of call history

---

## 8. Usage

```typescript
import { mosaicCompress, type MosaicConfig, type Message } from 'mosaic-compress';

const config: MosaicConfig = {
  lightStart: 30,
  lightWindow: 10,
  heavyStart: 50,
  heavyWindow: 10,
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
const compressed = await mosaicCompress(messages, config);
// compressed is now ready to pass to your main LLM
```

---

## 9. Relationship to Memory Systems

MosaicCompress is orthogonal to persistent memory systems (L1/L2/L3 memory hierarchy, vector databases, etc.):

| Dimension | Persistent Memory | MosaicCompress |
|-----------|-------------------|----------------|
| **What it does** | Extract persistent facts across sessions | Manage context window density |
| **Output** | Memory files → inject into system prompt | Compressed blocks → stay in messages array |
| **Lifetime** | Cross-session, persistent | Within current "logical conversation" |
| **Trigger** | Cron / conditional | Round threshold |

They complement each other: persistent memory captures "who the user is," MosaicCompress manages "what we're talking about right now."

---


## 10. Formal Model and the Engineering Choice

> This section is the **theoretical foundation** of the algorithm, not an
> implementation plan. It explains why MosaicCompress uses two levels
> (Light + Heavy) and why Heavy's recursive merge is mathematically sound.
> The exact multi-level model described below is deliberately NOT
> implemented — see 10.3 for the engineering rationale.

### 10.1 The exact model: position is age, nodes compress

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

### 10.2 V1's two levels = the 2-tier special case

- **Light (g=1)** = tier one of the exact model: per-node dehydration, node count unchanged.
- **Heavy (g=∞)** = the incremental-Heavy implementation: recursive merge
  (summaries of summaries); each window merges only the newly rolled-in
  `heavyWindow` rounds into the previous summary and always outputs 2
  messages — the "window-to-1 incremental" of 10.1, with `heavyWindow`
  substituted for the window.

V1's steady-state derivations (constant message count and token size) are
therefore direct consequences of the exact model.

### 10.3 Engineering choice: why two levels (Occam's razor)

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

## 11. License

MIT