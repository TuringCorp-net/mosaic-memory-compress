/** Standard chat message format (compatible with OpenAI, Anthropic, etc.) */
export interface Message {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_call_id?: string;
    tool_calls?: {
        id: string;
        type: 'function';
        function: {
            name: string;
            arguments: string;
        };
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
export declare const DEFAULT_CONFIG: Omit<MosaicMemoryConfig, 'callLLM'>;
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
export declare function mosaicMemoryCompress(messages: Message[], config: MosaicMemoryConfig): Promise<Message[]>;
//# sourceMappingURL=index.d.ts.map