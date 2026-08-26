// MosaicMemoryCompress — Stateless dialogue compression based on natural forgetting curve
//
// A pure function that partitions a message array into three zones by recency:
//   Heavy zone (oldest)  → compress ALL into 1 user + 1 assistant summary pair
//   Light zone (middle)  → distill each message independently, count unchanged
//   Raw zone  (newest)   → keep as-is
//
// Anti-jitter: lightWindow / heavyWindow control how often compression fires.

// ============================================================
// Types
// ============================================================

/** Standard chat message format (compatible with OpenAI, Anthropic, etc.) */
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }[];
  reasoning_content?: string;
  /**
   * Internal marker: message already light-distilled. Incremental semantics —
   * light only distills messages without this flag, so repeated triggers
   * never re-distill the same content. Hosts may strip it before persistence.
   */
  _distilled?: boolean;
  /**
   * Internal marker: message is a heavy-zone summary pair node. Excluded
   * from round counting so trigger points stay exact (40/50/60/…), matching
   * true user rounds instead of node positions.
   */
  _heavy?: boolean;
}

export interface MosaicMemoryConfig {
  /** Number of most recent rounds kept raw (no compression). Default 10 */
  lightStart: number;
  /** Anti-jitter window for Light Compress. Default 30 (aligned with heavy) */
  lightWindow: number;
  /** Rounds beyond this enter Heavy zone. Must be > lightStart. Default 30 */
  heavyStart: number;
  /** Anti-jitter window for Heavy Compress. Default 30 */
  heavyWindow: number;


  /**
   * LLM call function. Receives (systemPrompt, userInput) and returns the
   * model's text response. Users should wire this to their own LLM provider.
   *
   * Example using OpenAI:
   *   callLLM: async (sp, inp) => {
   *     const res = await openai.chat.completions.create({
   *       model: 'gpt-4o-mini',
   *       messages: [{ role: 'system', content: sp }, { role: 'user', content: inp }],
   *     });
   *     return res.choices[0].message.content ?? '';
   *   }
   */
  /**
   * LLM call function used by the HEAVY zone only (light is structural
   * truncation). Required when heavyStart is reachable; light-only usage can
   * omit it.
   */
  callLLM?: (systemPrompt: string, userInput: string) => Promise<string>;

  /**
   * Optional hook fired after each compression. Receives the original raw
   * payload that was compressed plus the compressed result, so hosts can
   * archive originals in their own persistence layer (database, log, or
   * platform spill) and re-read them later on demand. MosaicMemoryCompress itself
   * stays stateless — this is the interface for the architecture boundary,
   * not built-in storage. Errors thrown by the callback are logged and do
   * NOT break the compression flow.
   */
  onCompress?: (event: CompressEvent) => void | Promise<void>;
}

/** Payload passed to `onCompress` after Light or Heavy compression. */
export interface CompressEvent {
  /** Which zone was compressed: 'light' (distill, count unchanged) or 'heavy' (merged to 2 msgs). */
  zone: 'light' | 'heavy';
  /** Current round count at the time of compression. */
  round: number;
  /** The raw messages that were compressed (what a host should archive). */
  original: Message[];
  /** The compressed replacement messages. */
  compressed: Message[];
}

export const DEFAULT_CONFIG: Omit<MosaicMemoryConfig, 'callLLM'> = {
  lightStart: 10,
  lightWindow: 30,
  heavyStart: 30,
  heavyWindow: 30,
};

/**
 * Validates user-provided config before any work is done.
 * Throws a clear TypeError instead of silently producing NaN or
 * nonsensical zone boundaries.
 */
function validateConfig(config: MosaicMemoryConfig): void {
  if (!Number.isInteger(config.lightStart) || config.lightStart < 0) {
    throw new TypeError(
      `[mosaic-memory-compress] lightStart must be a non-negative integer, got ${config.lightStart}`,
    );
  }
  if (!Number.isInteger(config.lightWindow) || config.lightWindow <= 0) {
    throw new TypeError(
      `[mosaic-memory-compress] lightWindow must be a positive integer, got ${config.lightWindow}`,
    );
  }
  if (!Number.isInteger(config.heavyWindow) || config.heavyWindow <= 0) {
    throw new TypeError(
      `[mosaic-memory-compress] heavyWindow must be a positive integer, got ${config.heavyWindow}`,
    );
  }
  if (!Number.isInteger(config.heavyStart) || config.heavyStart <= config.lightStart) {
    throw new TypeError(
      `[mosaic-memory-compress] heavyStart (${config.heavyStart}) must be an integer greater than lightStart (${config.lightStart})`,
    );
  }
}

// ============================================================
// Main entry point
// ============================================================

/**
 * MosaicMemoryCompress — stateless dialogue compression.
 *
 * - Below lightStart rounds → zero-cost, returns immediately
 * - At window boundaries → Light Compress on Light zone, Heavy Compress on Heavy zone
 * - Idempotent: same input always yields same output regardless of call history
 *
 * @param messages - Full message array (system prompt at [0] if present)
 * @param config   - Compression config (must include callLLM)
 * @returns Compressed message array (system prompt unchanged)
 */
export async function mosaicMemoryCompress(
  messages: Message[],
  config: MosaicMemoryConfig,
): Promise<Message[]> {
  validateConfig(config);

  const hasSystem = messages.length > 0 && messages[0].role === 'system';
  const sysMsg = hasSystem ? [messages[0]] : [];
  const history = hasSystem ? messages.slice(1) : messages;

  // Count rounds — each user message starts a new round
  const roundStarts = findRoundStarts(history);
  const R = roundStarts.length;

  // Below threshold → immediate return
  if (R < config.lightStart) return messages;

  // Anti-jitter: only compress at window boundaries
  const needLight = R % config.lightWindow === 0;
  const needHeavy = R >= config.heavyStart && R % config.heavyWindow === 0;

  if (!needLight && !needHeavy) return messages;

  // Compute three-zone boundaries (0-based user-message indices)
  const heavyEnd = R - config.heavyStart;
  const lightEnd = R - config.lightStart;

  let result = [...history];

  // Light first (count unchanged), then Heavy (boundaries precomputed)
  if (needLight && lightEnd > 0) {
    result = await applyLightCompress(result, roundStarts, heavyEnd, lightEnd, R, config);
  }

  if (needHeavy && heavyEnd > 0) {
    result = await applyHeavyCompress(result, roundStarts, heavyEnd, R, config);
  }

  return [...sysMsg, ...result];
}

// ============================================================
// Round counting
// ============================================================

function findRoundStarts(history: Message[]): number[] {
  const starts: number[] = [];
  for (let i = 0; i < history.length; i++) {
    // Heavy summary pairs are memory artifacts, not user rounds — excluding
    // them keeps the trigger count equal to the true round number.
    if (history[i].role === 'user' && !history[i]._heavy) starts.push(i);
  }
  return starts;
}

// ============================================================
// Light Compress — distill each message, count unchanged
// ============================================================

async function applyLightCompress(
  history: Message[],
  roundStarts: number[],
  heavyEnd: number,
  lightEnd: number,
  round: number,
  config: MosaicMemoryConfig,
): Promise<Message[]> {
  const startIdx = heavyEnd > 0 ? roundStarts[heavyEnd] : 0;
  const endIdx = lightEnd < roundStarts.length ? roundStarts[lightEnd] : history.length;

  if (startIdx >= endIdx) return history;

  const target = history.slice(startIdx, endIdx);
  const compressed = await runLightCompressLLM(target, config);
  await emitCompressEvent(config, { zone: 'light', round, original: target, compressed });

  const result = [...history];
  result.splice(startIdx, endIdx - startIdx, ...compressed);
  return result;
}

/**
 * Light compress — PURE STRUCTURAL TRUNCATION, zero LLM calls.
 *
 * Data-driven redesign (2026-08-16): token composition of a real 40-round
 * surface showed reasoning 33% + tool-call arguments 33% + tool results 24%
 * vs. text only ~5%. LLM distillation of text was 90% waste (254 calls /
 * 12s / 380K tokens for 5.6% net savings). Structural truncation of the
 * big structured payloads gets 46% net savings at zero cost:
 *
 * - reasoning_content: head+tail 30 chars each (API-verified safe; DeepSeek
 *   replays reasoning_content on tool-call turns, truncated content is
 *   accepted and answered correctly)
 * - tool_calls[*].function.arguments: JSON shell preserved, every string
 *   field truncated to 120 chars (API-verified safe; only structure is
 *   validated)
 * - tool messages (results): text head 50 + tail 50 (structure untouched)
 * - user/assistant text: UNTOUCHED — stays fresh for the Heavy fold
 *
 * Incremental semantics unchanged: _distilled marker, re-triggers skip.
 */
const LIGHT_REASON_KEEP = 30
const LIGHT_ARG_FIELD_MAX = 120
const LIGHT_RESULT_HEAD = 50
const LIGHT_RESULT_TAIL = 50

/** Truncate one tool-call arguments JSON, preserving the JSON shell. */
function truncateArguments(raw: string): string {
  try {
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') {
        return v.length > LIGHT_ARG_FIELD_MAX ? v.slice(0, LIGHT_ARG_FIELD_MAX) + '…[truncated]' : v
      }
      if (Array.isArray(v)) return v.slice(0, 3).map(walk)
      if (v !== null && typeof v === 'object') {
        const out: Record<string, unknown> = {}
        for (const k of Object.keys(v as Record<string, unknown>)) out[k] = walk((v as Record<string, unknown>)[k])
        return out
      }
      return v
    }
    return JSON.stringify(walk(JSON.parse(raw)))
  } catch {
    return raw.length > LIGHT_ARG_FIELD_MAX ? raw.slice(0, LIGHT_ARG_FIELD_MAX) + '…[truncated]' : raw
  }
}

/** Truncate reasoning head+tail (field preserved — DeepSeek replays it). */
function truncateReasoning(text: string): string {
  if (text.length <= LIGHT_REASON_KEEP * 2 + 1) return text
  return text.slice(0, LIGHT_REASON_KEEP) + '…' + text.slice(-LIGHT_REASON_KEEP)
}

/** Truncate a tool-result text head+tail (30/30). */
function truncateToolResult(text: string): string {
  if (text.length <= LIGHT_RESULT_HEAD + LIGHT_RESULT_TAIL) return text
  return text.slice(0, LIGHT_RESULT_HEAD) + '\n…[truncated]…\n' + text.slice(-LIGHT_RESULT_TAIL)
}

async function runLightCompressLLM(
  messages: Message[],
  _config: MosaicMemoryConfig,
): Promise<Message[]> {
  return messages.map((m) => {
    if (m._distilled) return m
    const next: Message = { ...m }
    if (m.role === 'tool') {
      const text = (m.content || '').trim()
      if (text.length > LIGHT_RESULT_HEAD + LIGHT_RESULT_TAIL) next.content = truncateToolResult(text)
    } else if (m.role === 'assistant') {
      if (m.reasoning_content && m.reasoning_content.length > LIGHT_REASON_KEEP * 2 + 1) {
        next.reasoning_content = truncateReasoning(m.reasoning_content)
      }
      if (m.tool_calls && m.tool_calls.length > 0) {
        next.tool_calls = m.tool_calls.map(tc => ({
          ...tc,
          function: { ...tc.function, arguments: truncateArguments(tc.function.arguments) },
        }))
      }
    }
    // user text (and already-terse messages) pass through untouched
    next._distilled = true
    return next
  })
}

// ============================================================
// Heavy Compress — entire Heavy zone → 2 messages
// ============================================================

async function applyHeavyCompress(
  history: Message[],
  roundStarts: number[],
  heavyEnd: number,
  round: number,
  config: MosaicMemoryConfig,
): Promise<Message[]> {
  const endIdx = heavyEnd < roundStarts.length ? roundStarts[heavyEnd] : history.length;
  const target = history.slice(0, endIdx);

  if (target.length === 0) return history;

  const pair = await runHeavyCompressLLM(target, config);
  // Summary-pair nodes are memory artifacts, not user rounds — the flag keeps
  // round counting exact (findRoundStarts skips them).
  for (const m of pair) m._heavy = true;
  await emitCompressEvent(config, { zone: 'heavy', round, original: target, compressed: pair });

  const result = [...history];
  result.splice(0, endIdx, ...pair);
  return result;
}

/** Fires the optional onCompress hook; callback errors never break the flow. */
async function emitCompressEvent(config: MosaicMemoryConfig, event: CompressEvent): Promise<void> {
  if (!config.onCompress) return;
  try {
    await config.onCompress(event);
  } catch (err) {
    console.error('[mosaic-memory-compress] onCompress callback failed:', (err as Error).message);
  }
}

async function runHeavyCompressLLM(
  messages: Message[],
  config: MosaicMemoryConfig,
): Promise<Message[]> {
  const inputText = messages.map((m, i) => {
    const roleLabel = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role;
    return `[${i}] ${roleLabel}: ${(m.content || '').substring(0, 200)}`;
  }).join('\n\n');

  if (!config.callLLM) {
    throw new Error('[mosaic-memory-compress] heavy compression requires callLLM');
  }
  const systemPrompt = `You are a dialogue compressor. Compress the conversation below into exactly 2 messages (a summary pair). Preserve the original language of the input.

## Principles
1. Output EXACTLY 2 messages:
   - Message 1 (role: "user"): a summary listing key decisions, preferences, creative directions, todos/commitments
   - Message 2 (role: "assistant"): a confirmation listing recorded directions and pending follow-ups
2. Ancient, redundant information already covered by later conversations can be omitted
3. Use declarative facts, one per line. Keep the total under 500 words.
4. Preserve unfinished action items that need follow-up

## Output format
Output ONLY a JSON array (no other text):
[{"role": "user", "content": "<summary>"}, {"role": "assistant", "content": "<confirmation>"}]`;

  try {
    const content = await config.callLLM(systemPrompt, inputText);
    return parseHeavyResult(content);
  } catch (err) {
    console.error('[mosaic-memory-compress] Heavy Compress LLM call failed:', (err as Error).message);
    return [
      { role: 'user', content: '[Compression failed] Conversation continues.' },
      { role: 'assistant', content: '[Acknowledged] Issue does not affect the conversation.' },
    ];
  }
}

/**
 * Extracts the first JSON array from an LLM reply.
 * Tolerates Markdown code fences (```json ... ```) and stray prose —
 * both are common with real LLM outputs.
 */
function extractJsonArray(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const m = body.match(/\[[\s\S]*\]/);
  return m ? m[0] : null;
}

function parseHeavyResult(raw: string): Message[] {
  try {
    const arr = extractJsonArray(raw);
    if (!arr) throw new Error('No JSON array found');
    const items: { role?: string; content?: string }[] = JSON.parse(arr);
    const pair: Message[] = [];
    for (const item of items) {
      if (pair.length >= 2) break;
      // Normalize the role: only 'user'/'assistant' are legal in the output
      // pair. Anything else (system, tool, typos, missing) is treated as a
      // malformed entry and skipped.
      if (item.role !== 'user' && item.role !== 'assistant') continue;
      pair.push({ role: item.role, content: item.content || '' });
    }
    // Must end with exactly 2 messages (user summary + assistant confirmation)
    if (pair.length !== 2) throw new Error('Expected 2 normalized messages');
    return pair;
  } catch {
    return [
      { role: 'user', content: '[Compression failed] Summary unavailable.' },
      { role: 'assistant', content: '[Acknowledged] Conversation can continue.' },
    ];
  }
}