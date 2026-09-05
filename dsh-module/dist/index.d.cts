import * as _deepseek_ai_dsh_llm from '@deepseek-ai/dsh-llm';
import { Message, ContentBlock } from '@deepseek-ai/dsh-llm';
import { Context } from '@deepseek-ai/cordis';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import { CompactionTrigger, CompactionResult } from '@deepseek-ai/dsh-compaction';
import { Agent } from '@deepseek-ai/dsh-agent';

/** Zone thresholds in memory-round (user-message) units. */
interface MosaicMemoryConfig {
    /** Most recent N memory rounds kept raw (default 10). */
    lightStart: number;
    /** Anti-jitter: run compression every N rounds (default 30). */
    lightWindow: number;
    /** Rounds older than this fold into the heavy checkpoint (default 30). */
    heavyStart: number;
    /** Anti-jitter for the heavy fold (default 30). */
    heavyWindow: number;
    /** Generation cap for the heavy checkpoint (default 8192). */
    maxTokens: number;
    /**
     * Session allowlist (safety gate). Only sessions listed here are
     * compressed; everything else is a zero-cost no-op. Default [] = nothing
     * is compressed until explicitly enabled. Use ['*'] to allow every
     * session (the pre-allowlist behavior). First-time users: list exactly
     * the session id(s) they want to try.
     */
    sessionAllowlist?: string[];
    /**
     * Session denylist — takes precedence over the allowlist. Sessions listed
     * here are never compressed, even when the allowlist is ['*'] or contains
     * them. Typical use: keep one reference conversation (e.g. the developer
     * session that knows the full picture) out of a fleet-wide rollout, so a
     * clean, unmanaged conversation always exists for diagnosis/recovery.
     */
    sessionDenylist?: string[];
}
declare class MosaicMemoryCompactionEngine extends BasicCompactionEngine {
    static inject: string[];
    private readonly mosaic;
    /**
     * Surface seqs already light-distilled by an earlier trigger. Incremental
     * semantics: light never re-distills the same node, matching the library's
     * _distilled marker. In-memory only — after a host restart the next trigger
     * re-distills once (correct, just one extra pass).
     */
    private readonly distilledSeqs;
    /** Per-pre-step light statistics for the journal diagnostics. */
    private lightStats;
    /**
     * Per-session trigger state (lazily initialized): { light, heavy } = the
     * round that pass last ran at, seeded with the zone starts so a fresh mount
     * fires once R is a full window past them. Light and heavy are fully
     * DECOUPLED: light is zero-LLM dehydration and deserves its own cadence
     * (first run at R ≥ lightStart + lightWindow, e.g. 40), while heavy is the
     * costly fold with its own (first at R ≥ heavyStart + heavyWindow, e.g. 60)
     * so a 30..59-round session de-waters without paying a one-round fold.
     * Per-session: one conversation's trigger must never gate another's.
     */
    private readonly triggerState;
    private stateOf;
    /**
     * Incremental round counters (per session), maintained via session/event.
     * no-op pre-steps read this in O(1) instead of rescanning the whole log.
     * Correctness is guaranteed by three rules:
     * - append of a real user message → +1 (event stream is append-only);
     * - 1:1 surface replacements (our light pass) keep the user source → count
     *   unchanged, no invalidation;
     * - any RANGE replacement (heavy fold, official checkpoint, anything else)
     *   marks the session dirty → the next pre-step recomputes from scratch
     *   (and the trigger path recomputes anyway for zones).
     * A fresh session (or restart) starts with no entry → first pre-step scans
     * once. This is self-adapting: cost per no-op pre-step stays O(1) forever,
     * independent of conversation growth.
     */
    private readonly roundCounts;
    private readonly dirtySessions;
    constructor(ctx: Context, config?: Partial<MosaicMemoryConfig>);
    /**
     * Anti-jitter trigger on the user-round count. Returns null (zero cost)
     * below threshold or off-window. context-overflow forces a run.
     */
    compactIfNeeded(agent: Agent, trigger: CompactionTrigger, signal: AbortSignal): Promise<CompactionResult | null>;
    /** Memory rounds = genuine user messages on the surface. */
    private countUserRounds;
    /** Full recount (O(n)): rebuild the per-session counter from the live surface. */
    private recount;
    /** O(1) read with lazy init and dirty-session fallback. */
    private userRounds;
    /**
     * All surface nodes (model-visible order, oldest first) with payloads.
     * Indexed by seq: sessions grow to tens of thousands of events, and a
     * linear find per node would make every pre-step O(n²) (measured: 17.7s
     * on a 38k-event session). One O(n) index build per call. Only called on
     * the trigger path (every lightWindow rounds) and on recount — never on
     * the no-op hot path.
     */
    private surfaceNodes;
    /**
     * Position-is-age zones: count user rounds from the tail (newest = 0);
     * each zone boundary snaps to a user round so assistant/tool messages stay
     * whole and tool pairing is never cut.
     */
    private computeZones;
    /**
     * Self-implemented heavy fold (replaces the official compactRegion, whose
     * token-meter strict state machine rejects replacement events carrying
     * historical turn/step — measured on 2026-08-27 mount).
     *
     * Strips the ancient zone down to user/assistant TEXT ONLY (tool calls,
     * tool results and reasoning are dropped — they are not useful to the
     * summary), sends one LLM call, then lands a bounded summary pair with
     * official-shaped compaction/start|summary|end events so projections and
     * the UI consume it unchanged.
     */
    private heavyFold;
    /** Text-only rendering of a message: user/assistant text blocks; tool noise dropped. */
    private textOnly;
    /** Latest turn number from the session log. */
    private latestTurn;
    /**
     * Per-node 1:1 surface replacement over the light zone.
     * Pure structural truncation — synchronous, zero LLM calls.
     */
    private lightPass;
    /**
     * Light pass is PURE STRUCTURAL TRUNCATION (zero LLM calls): real-surface
     * token composition is reasoning 33% + tool-call arguments 33% + tool
     * results 24% vs. text ~5% (measured 2026-08-16). Truncating the big
     * structured payloads yields ~46% net surface savings at zero cost.
     * All truncations API-verified safe with DeepSeek.
     */
    private structuralTruncate;
    /** Routed provider/model: session request header, else agent options. */
    private llmTarget;
    /**
     * Heavy checkpoint: official summarization machinery, mosaic instruction.
     * The replayed region includes the previous checkpoint node, so this is a
     * summary-of-summary by construction — bounded by maxTokens, never grows.
     */
    protected summarize(input: {
        system?: string;
        tools?: readonly _deepseek_ai_dsh_llm.ToolSchema[];
        messages: readonly Message[];
    }, agent: Agent, signal?: AbortSignal): Promise<{
        summary: ContentBlock[];
        provider: string;
        model: string;
        maxTokens?: number;
        usage?: _deepseek_ai_dsh_llm.TokenUsage;
        rawOutput: ContentBlock[];
        llmStreamCall: true;
    }>;
}
/** Cordis plugin entry. */
declare function apply(ctx: Context, config?: Partial<MosaicMemoryConfig>): void;

export { MosaicMemoryCompactionEngine, type MosaicMemoryConfig, apply, MosaicMemoryCompactionEngine as default };
