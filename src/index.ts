// MosaicCompress — Stateless dialogue compression based on natural forgetting curve
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
}

export interface MosaicConfig {
  /** Number of most recent rounds kept raw (no compression). Default 30 */
  lightStart: number;
  /** Anti-jitter window for Light Compress. Default 10 */
  lightWindow: number;
  /** Rounds beyond this enter Heavy zone. Must be > lightStart. Default 50 */
  heavyStart: number;
  /** Anti-jitter window for Heavy Compress. Default 10 */
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
  callLLM: (systemPrompt: string, userInput: string) => Promise<string>;

  /**
   * Optional hook fired after each compression. Receives the original raw
   * payload that was compressed plus the compressed result, so hosts can
   * archive originals in their own persistence layer (database, log, or
   * platform spill) and re-read them later on demand. MosaicCompress itself
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

export const DEFAULT_CONFIG: Omit<MosaicConfig, 'callLLM'> = {
  lightStart: 30,
  lightWindow: 10,
  heavyStart: 50,
  heavyWindow: 10,
};

/**
 * Validates user-provided config before any work is done.
 * Throws a clear TypeError instead of silently producing NaN or
 * nonsensical zone boundaries.
 */
function validateConfig(config: MosaicConfig): void {
  if (!Number.isInteger(config.lightStart) || config.lightStart < 0) {
    throw new TypeError(
      `[mosaic_compress] lightStart must be a non-negative integer, got ${config.lightStart}`,
    );
  }
  if (!Number.isInteger(config.lightWindow) || config.lightWindow <= 0) {
    throw new TypeError(
      `[mosaic_compress] lightWindow must be a positive integer, got ${config.lightWindow}`,
    );
  }
  if (!Number.isInteger(config.heavyWindow) || config.heavyWindow <= 0) {
    throw new TypeError(
      `[mosaic_compress] heavyWindow must be a positive integer, got ${config.heavyWindow}`,
    );
  }
  if (!Number.isInteger(config.heavyStart) || config.heavyStart <= config.lightStart) {
    throw new TypeError(
      `[mosaic_compress] heavyStart (${config.heavyStart}) must be an integer greater than lightStart (${config.lightStart})`,
    );
  }
}

// ============================================================
// Main entry point
// ============================================================

/**
 * MosaicCompress — stateless dialogue compression.
 *
 * - Below lightStart rounds → zero-cost, returns immediately
 * - At window boundaries → Light Compress on Light zone, Heavy Compress on Heavy zone
 * - Idempotent: same input always yields same output regardless of call history
 *
 * @param messages - Full message array (system prompt at [0] if present)
 * @param config   - Compression config (must include callLLM)
 * @returns Compressed message array (system prompt unchanged)
 */
export async function mosaicCompress(
  messages: Message[],
  config: MosaicConfig,
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
    if (history[i].role === 'user') starts.push(i);
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
  config: MosaicConfig,
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

async function runLightCompressLLM(
  messages: Message[],
  config: MosaicConfig,
): Promise<Message[]> {
  const msgLines = messages.map((m, i) => {
    const content = m.content || '';
    const roleLabel = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role;
    return `[${i}] ${roleLabel}: ${content}`;
  }).join('\n\n');

  const systemPrompt = `You are a dialogue compressor. Compress each message below to its essential core — remove filler words, repetition, and small talk. Preserve the original language of the input.

## Principles
1. Compress each message independently. Output order and numbering MUST match input exactly.
2. Preserve: user decisions, preferences, feedback, assistant conclusions, commitments, key suggestions
3. Remove: filler words, repeated confirmations, small talk, completed tool-call processes
4. Keep each compressed message concise (≤80 words)
5. Tool-call transcripts: for assistant messages that carry tool_calls, compress
   the prose but keep the function call intact in your mind; for role "tool"
   messages, compress the result to its essential conclusion (they are usually
   the largest messages). NEVER reorder or drop indices.

## Output format
Output ONLY a JSON array (no other text):
[{"i": <index>, "c": "<compressed content>"}, ...]`;

  try {
    const content = await config.callLLM(
      systemPrompt,
      `Please compress the following ${messages.length} messages:\n\n${msgLines}`,
    );
    return parseLightResult(content, messages);
  } catch (err) {
    console.error('[mosaic_compress] Light Compress LLM call failed:', (err as Error).message);
    return messages;
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

function parseLightResult(raw: string, original: Message[]): Message[] {
  try {
    const arr = extractJsonArray(raw);
    if (!arr) return original;
    const items: { i: number; c: string }[] = JSON.parse(arr);
    const map = new Map<number, string>();
    for (const item of items) map.set(item.i, item.c);
    return original.map((msg, i) => {
      const c = map.get(i);
      if (!c || c.length === 0) return msg; // missing → keep verbatim, never truncate

      const next: Message = { ...msg, content: c };
      // Structural fields must survive compression so the message array stays
      // valid for OpenAI-compatible APIs:
      //  - tool_calls: pairing with following tool messages depends on the
      //    assistant message having tool_calls; keep the skeleton.
      //  - tool_call_id: same pairing for role:tool messages; keep it.
      //  - reasoning_content: stripped — it is noise for the next turn and is
      //    not validated by APIs.
      delete (next as { reasoning_content?: string }).reasoning_content;
      return next;
    });
  } catch {
    return original;
  }
}

// ============================================================
// Heavy Compress — entire Heavy zone → 2 messages
// ============================================================

async function applyHeavyCompress(
  history: Message[],
  roundStarts: number[],
  heavyEnd: number,
  round: number,
  config: MosaicConfig,
): Promise<Message[]> {
  const endIdx = heavyEnd < roundStarts.length ? roundStarts[heavyEnd] : history.length;
  const target = history.slice(0, endIdx);

  if (target.length === 0) return history;

  const pair = await runHeavyCompressLLM(target, config);
  await emitCompressEvent(config, { zone: 'heavy', round, original: target, compressed: pair });

  const result = [...history];
  result.splice(0, endIdx, ...pair);
  return result;
}

/** Fires the optional onCompress hook; callback errors never break the flow. */
async function emitCompressEvent(config: MosaicConfig, event: CompressEvent): Promise<void> {
  if (!config.onCompress) return;
  try {
    await config.onCompress(event);
  } catch (err) {
    console.error('[mosaic_compress] onCompress callback failed:', (err as Error).message);
  }
}

async function runHeavyCompressLLM(
  messages: Message[],
  config: MosaicConfig,
): Promise<Message[]> {
  const inputText = messages.map((m, i) => {
    const roleLabel = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role;
    return `[${i}] ${roleLabel}: ${(m.content || '').substring(0, 200)}`;
  }).join('\n\n');

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
    console.error('[mosaic_compress] Heavy Compress LLM call failed:', (err as Error).message);
    return [
      { role: 'user', content: '[Compression failed] Conversation continues.' },
      { role: 'assistant', content: '[Acknowledged] Issue does not affect the conversation.' },
    ];
  }
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
