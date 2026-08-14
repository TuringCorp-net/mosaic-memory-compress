# MosaicCompress

**Stateless dialogue compression based on natural forgetting curve.**

LLM conversations grow linearly. MosaicCompress keeps them bounded — automatically, invisibly, and without the user ever knowing what a "Session" is.

## How It Works

```
Your message array (R rounds, oldest → newest):

Round 1 ────→ Round (R-50)   │ Heavy zone → ALL → 2 msgs
Round (R-49) → Round (R-30)  │ Light zone → distill each, count unchanged
Round (R-29) ──→ Round R     │ Raw zone  → keep as-is
```

**Steady state: always 82 messages**, whether at round 60 or round 15,000. The compression ratio approaches 100%.

## Quick Start

```bash
npm install mosaic-compress
```

```typescript
import { mosaicCompress, type MosaicConfig } from 'mosaic-compress';

const config: MosaicConfig = {
  lightStart: 30,    // keep 30 most recent rounds raw
  lightWindow: 10,   // compress every 10 rounds
  heavyStart: 50,    // rounds before this get heavy compression
  heavyWindow: 10,   // same cadence as light
  callLLM: async (systemPrompt, userInput) => {
    // Wire to OpenAI, Anthropic, or any LLM provider
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userInput },
      ],
    });
    return res.choices[0].message.content ?? '';
  },
};

// Call every turn — zero cost below threshold, ~1-2s delay at compression milestones
const compressed = await mosaicCompress(messages, config);
```

## Features

- **Stateless & Idempotent** — same input always yields same output
- **Zero-cost below threshold** — returns immediately if no compression is due
- **Anti-jitter** — compression only at configurable window boundaries
- **LLM-agnostic** — bring your own `callLLM` function (OpenAI, Anthropic, local models…)
- **Tool-call safe** — tool messages don't break round counting
- **Graceful degradation** — LLM failures don't block the conversation

## API

### `mosaicCompress(messages, config)`

| Param | Type | Description |
|-------|------|-------------|
| `messages` | `Message[]` | Full message array. System prompt at `[0]` is preserved as-is. |
| `config` | `MosaicConfig` | Compression config (see below). |
| **Returns** | `Promise<Message[]>` | Compressed message array. |

### `MosaicConfig`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `lightStart` | `number` | `30` | Most recent N rounds kept raw |
| `lightWindow` | `number` | `10` | Anti-jitter: compress every N rounds |
| `heavyStart` | `number` | `50` | Rounds beyond this → Heavy zone |
| `heavyWindow` | `number` | `10` | Anti-jitter for heavy compression |
| `callLLM` | `(sys: string, user: string) => Promise<string>` | *required* | Your LLM call function |

### `DEFAULT_CONFIG`

Prefer starting from the exported defaults and overriding only what you need:

```typescript
import { mosaicCompress, DEFAULT_CONFIG, type MosaicConfig } from 'mosaic-compress';

const config: MosaicConfig = { ...DEFAULT_CONFIG, callLLM: async (sys, user) => { /* ... */ } };
```

All numeric fields must be positive integers (windows) / non-negative integers (starts),
and `heavyStart` must be greater than `lightStart`. Invalid configs throw a `TypeError`.

### `Message`

```typescript
interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
}
```

## Efficiency

| Rounds | Uncompressed | Compressed | Reduction |
|--------|-------------|-----------|-----------|
| 100 | 100K tokens | 33.7K | 66% |
| 500 | 500K tokens | 33.7K | 93% |
| 5,000 | 5M tokens | 33.7K | 99.3% |
| 15,000 | 15M tokens | 33.7K | 99.8% |

From round 60 onward, the compressed size is **completely constant**.

## Design

Read the [full design document (English)](docs/design.md) or [中文设计文档](docs/design.cn.md).

## Architecture Boundaries

MosaicCompress is intentionally **stateless and lossy**:

- **Durable storage is the host's responsibility.** The library compresses
  the message array in place and never persists original payloads. Hosts
  that need lossless history must archive the raw messages themselves —
  through their own code, a database, or platform mechanisms such as
  DeepSeek Harness sessions / `spill` (an `onCompress` callback to hand
  originals to the host is planned — see [Roadmap](docs/ROADMAP.md) M2).
- **Compression is lossy by design.** Like any summarization approach, early
  details fade progressively. That is the point: the goal is an unbounded
  conversation, not lossless archival. If exact retrieval of early turns
  matters, pair this library with a persistence layer and re-read on demand.

## DeepSeek Harness Integration

MosaicCompress is developed as a **first-class companion to DeepSeek Harness
(DSH)** — its primary integration target.

**Complementary, not redundant.** DSH already ships agent-task-level
mechanisms: `compaction` (task-context summarization), `output-retention`
(head/tail truncation of large tool outputs), and `spill` (overflow payloads
persisted to disk and re-readable). These operate on tool results and task
context. MosaicCompress covers what they do not: **message-level dialogue** —
preserving the conversation skeleton (roles, order, count) while distilling
older rounds along a forgetting curve.

**Cooperation pattern.** When integrated, MosaicCompress will hand
compressed-away originals to DSH's persistence/`spill` layer via a callback,
so nothing is silently lost and nothing is re-invented.

**Focused roadmap.** The adaptive-threshold milestone
([Roadmap](docs/ROADMAP.md) M1) targets DeepSeek V4's 1M-token context
window and beyond: thresholds should derive from the model's context size
and current usage ratio rather than fixed heuristics.

This project is maintained by an individual developer and deliberately
specializes: instead of a one-size-fits-all library, it optimizes for
DeepSeek Harness, with the ambition of becoming a recommended — and
eventually built-in — module.

## Development

```bash
# Run tests (zero LLM cost — uses mock responses)
npm test

# Or directly:
npx tsx tests/index.test.ts
```

## License

MIT — [TuringCorp](https://www.turingcorp.net) | [iAsk@turingcorp.net](mailto:iAsk@turingcorp.net)
