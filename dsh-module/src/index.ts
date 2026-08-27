/**
 * MosaicMemoryCompactionEngine — natural forgetting-curve compaction for DSH.
 *
 * Prototype: subclasses BasicCompactionEngine so the official durable
 * transaction (locking, compaction/start|end markers, replay-stability
 * checks, checkpoint framing) stays untouched. What differs is *what* gets
 * compressed and *how*:
 *
 *   raw  zone (recent lightStart rounds)  → untouched, zero overhead
 *   light zone (lightStart..heavyStart)   → per-node surface replacement,
 *                                           message count unchanged
 *   heavy zone (older than heavyStart)    → official compactRegion() folding
 *                                           the ancient region into ONE
 *                                           bounded checkpoint node
 *
 * Position-is-age: zones are computed from surface node positions, counting
 * user rounds from the tail. No round ledger is tracked.
 *
 * Known prototype limitations (see DESIGN.md §8):
 * - compactNow (manual /compact) is inherited from BasicCompactionEngine and
 *   still produces the official one-shot full summary; unifying it with the
 *   mosaic passes is next.
 * - O(n²) event lookups by seq; fine at prototype scale.
 */

import { Context } from '@deepseek-ai/cordis'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import {
  isCompactCheckpointSource,
} from '@deepseek-ai/dsh-compaction'
import type {
  CompactionResult,
  CompactionTrigger,
} from '@deepseek-ai/dsh-compaction'
import {
  BlockAssembler,
  createAssistantMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  Message,
  TextBlock,
} from '@deepseek-ai/dsh-llm'
import { deriveEventMessage, isSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { zoneBoundaries } from './zones.ts'
import { randomUUID } from 'node:crypto'

/** Zone thresholds in memory-round (user-message) units. */
export interface MosaicMemoryConfig {
  /** Most recent N memory rounds kept raw (default 10). */
  lightStart: number
  /** Anti-jitter: run compression every N rounds (default 30). */
  lightWindow: number
  /** Rounds older than this fold into the heavy checkpoint (default 30). */
  heavyStart: number
  /** Anti-jitter for the heavy fold (default 30). */
  heavyWindow: number

  /** Generation cap for the heavy checkpoint (default 8192). */
  maxTokens: number

  /**
   * Session allowlist (safety gate). Only sessions listed here are
   * compressed; everything else is a zero-cost no-op. Default [] = nothing
   * is compressed until explicitly enabled. Use ['*'] to allow every
   * session (the pre-allowlist behavior). First-time users: list exactly
   * the session id(s) they want to try.
   */
  sessionAllowlist?: string[]
}

/** Light structural-truncation limits (mirror the library's light pass). */
const LIGHT_REASON_KEEP = 30
const LIGHT_ARG_FIELD_MAX = 120
const LIGHT_RESULT_HEAD = 50
const LIGHT_RESULT_TAIL = 50
const LIGHT_INJECT_MAX = 30

/** Truncate one tool-call arguments JSON, preserving the JSON shell. */
function truncateArguments(raw: string): string {
  try {
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') return v.length > LIGHT_ARG_FIELD_MAX ? v.slice(0, LIGHT_ARG_FIELD_MAX) + '…[truncated]' : v
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

/** Heavy-zone checkpoint instruction — mirrors the library's Heavy prompt:
 * role + structure, content selection left to the model. */
const HEAVY_INSTRUCTION = `You are a dialogue memory compressor. The recent
rounds of this conversation stay verbatim; your job is to condense only the
ANCIENT part below into one compact memory node that preserves what must
survive forgetting.

## Principles
1. You decide what is worth keeping — key decisions, preferences, creative
   directions, unfinished action items, lessons. Ancient, redundant
   information already covered by later conversation may be omitted.
2. Use declarative facts, one per line.
3. Preserve unfinished action items that need follow-up.
4. Preserve the original language of the input. Keep it terse.`

/** Defaults mirror the library's DEFAULT_CONFIG. */
const DEFAULTS: Required<MosaicMemoryConfig> = {
  lightStart: 10,
  lightWindow: 30,
  heavyStart: 30,
  heavyWindow: 30,
  maxTokens: 8192,
  sessionAllowlist: [],
}

/** One surface node with its message payload. */
interface SurfaceEntry {
  seq: number
  event: import('@deepseek-ai/dsh-session').SessionEvent
  message: Message
}

/** Zone boundaries in surface-node indices (nodes[0] = oldest). */
interface Zones {
  /** Per-node replacement candidates, oldest → newest. */
  light: SurfaceEntry[]
  /** Node seqs folding into the heavy checkpoint. */
  heavy: { start: number; end: number }
  /** Skip heavy entirely when no compactable ancient region exists. */
  heavyEmpty: boolean
}

/**
 * Whether a message is a genuine user round.
 *
 * The EXACT counting unit (matches the library's design): a "round" is one
 * real user message — source.kind === 'user'. Everything else is excluded:
 * - tool results (role:'user', source.kind==='tool')
 * - system injections (source.kind==='plugin': runtime context, time
 *   context, AGENTS.md, …)
 * - official compaction checkpoints (source.kind==='plugin', plugin==='compact')
 *
 * This keeps the trigger count equal to the true user-message count, exactly
 * as the library's findRoundStarts counts user nodes.
 */
function isUserRound(message: Message): boolean {
  return message.role === 'user' && message.source.kind === 'user'
}

export class MosaicMemoryCompactionEngine extends BasicCompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions']

  private readonly mosaic: Required<MosaicMemoryConfig>

  /**
   * Surface seqs already light-distilled by an earlier trigger. Incremental
   * semantics: light never re-distills the same node, matching the library's
   * _distilled marker. In-memory only — after a host restart the next trigger
   * re-distills once (correct, just one extra pass).
   */
  private readonly distilledSeqs = new Set<number>()

  /** Per-pre-step light statistics for the journal diagnostics. */
  private lightStats = { calls: 0, tokens: 0 }

  /**
   * Window-level dedup: R stays on a window boundary across the steps of one
   * turn (pre-step runs per step), so without this guard the same round
   * would re-trigger full distillation for every step. One trigger per round.
   */
  private lastTriggeredRound = -1

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
  private readonly roundCounts = new Map<string, number>()
  private readonly dirtySessions = new Set<string>()

  constructor(ctx: Context, config: Partial<MosaicMemoryConfig> = {}) {
    const mosaic: Required<MosaicMemoryConfig> = { ...DEFAULTS, ...config }
    if (mosaic.lightStart < 0 || mosaic.lightWindow <= 0
      || mosaic.heavyStart <= mosaic.lightStart || mosaic.heavyWindow <= 0) {
      throw new TypeError('mosaic: invalid zones (need 0 ≤ lightStart < heavyStart, windows > 0)')
    }
    super(ctx, { auto: true })
    this.mosaic = mosaic
    // Relative-window trigger: lastTriggeredRound starts at heavyStart so a
    // first mount compresses immediately once R exceeds one window past it
    // (e.g. R=92 → delta 62 ≥ 30 → fires), regardless of R % window == 0.
    this.lastTriggeredRound = mosaic.heavyStart
    // Incremental round counters: watch the append-only event stream.
    ctx.on('session/event', (session: import('@deepseek-ai/dsh-session').Session, event: import('@deepseek-ai/dsh-session').SessionEvent) => {
      if (!isSurfaceEvent(event)) return
      const op = event.surfaceOp
      if (event.type === 'user/message' && op === 'append'
        && event.data?.source?.kind === 'user') {
        const c = this.roundCounts.get(session.id)
        if (c !== undefined) this.roundCounts.set(session.id, c + 1)
      } else if (op !== 'append' && op.op === 'replace'
        && op.start !== op.end) {
        // Range fold (heavy checkpoint or any third-party compaction):
        // visible user-round count may have changed → recompute on next use.
        this.dirtySessions.add(session.id)
      }
    })
    console.log('[mosaic-memory-compact] engine constructed (lightStart=' + mosaic.lightStart
      + ', heavyStart=' + mosaic.heavyStart + ')')
  }

  // ─────────────────────────────────────────────────────────────── trigger

  /**
   * Anti-jitter trigger on the user-round count. Returns null (zero cost)
   * below threshold or off-window. context-overflow forces a run.
   */
  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    // Safety gate: only allowlisted sessions are compressed. Default []
    // disables everything until explicitly enabled — first-time users list
    // the session id(s) they want to try, so a bad experiment can never
    // touch other conversations.
    const allow = this.mosaic.sessionAllowlist ?? []
    if (!allow.includes('*') && !allow.includes(agent.session.id)) {
      return null
    }
    const t0 = Date.now()
    this.lightStats = { calls: 0, tokens: 0 }
    const userCount = this.userRounds(agent.session)
    // Relative window: fire when at least one window has elapsed since the
    // last compression. First mount: delta = R - heavyStart, so any R more
    // than one window past the heavy threshold fires immediately — the
    // "R not a multiple of 30" case can never stall a fresh install.
    const offWindow = userCount - this.lastTriggeredRound < this.mosaic.heavyWindow
    const belowThreshold = userCount < this.mosaic.lightStart
    const alreadyTriggered = userCount === this.lastTriggeredRound
    if (trigger !== 'context-overflow' && (belowThreshold || offWindow || alreadyTriggered)) {
      console.log('[mosaic] pre-step sid=' + agent.session.id.slice(0, 8)
        + ' R=' + userCount + ' trigger=' + trigger
        + (alreadyTriggered ? ' dedup' : '')
        + ' no-op (' + (Date.now() - t0) + 'ms)')
      return null
    }
    this.lastTriggeredRound = userCount

    const zones = this.computeZones(agent)

    // Light first: 1:1 replacements keep the surface structure (count, roles,
    // pairing) intact, so the heavy range computed before remains valid.
    if (zones.light.length > 0) {
      await this.lightPass(agent, zones.light, signal)
    }

    // Heavy second: self-implemented fold (official compactRegion is
    // unusable here — its token-meter strict state machine rejects
    // replacement events carrying historical turn/step, measured 2026-08-27).
    // Events mimic the official shape (compaction/start|summary|end) so
    // projections and the UI consume them unchanged.
    if (!zones.heavyEmpty && userCount >= this.mosaic.heavyStart) {
      const result = await this.heavyFold(agent, zones.heavy.start, zones.heavy.end, signal)
      this.lastTriggeredRound = this.mosaic.heavyStart // folded → R settles at 30
      console.log('[mosaic] pre-step sid=' + agent.session.id.slice(0, 8)
        + ' R=' + userCount + ' trigger=' + trigger
        + ' TRIGGERED lightCalls=' + this.lightStats.calls
        + ' lightTokens=' + this.lightStats.tokens
        + ' heavyFolded=' + result.shadowedSeqs.length + ' nodes'
        + ' (' + (Date.now() - t0) + 'ms)')
      return result
    }
    console.log('[mosaic] pre-step sid=' + agent.session.id.slice(0, 8)
      + ' R=' + userCount + ' trigger=' + trigger
      + ' TRIGGERED lightCalls=' + this.lightStats.calls
      + ' lightTokens=' + this.lightStats.tokens
      + ' heavy=none (below heavyStart) (' + (Date.now() - t0) + 'ms)')
    return null
  }

  // ───────────────────────────────────────────────────────────────── zones

  /** Memory rounds = genuine user messages on the surface. */
  private countUserRounds(session: import('@deepseek-ai/dsh-session').Session): number {
    return this.surfaceNodes(session).filter(n => isUserRound(n.message)).length
  }

  /** Full recount (O(n)): rebuild the per-session counter from the live surface. */
  private recount(session: import('@deepseek-ai/dsh-session').Session): number {
    const count = this.countUserRounds(session)
    this.roundCounts.set(session.id, count)
    this.dirtySessions.delete(session.id)
    return count
  }

  /** O(1) read with lazy init and dirty-session fallback. */
  private userRounds(session: import('@deepseek-ai/dsh-session').Session): number {
    const cached = this.roundCounts.get(session.id)
    if (cached !== undefined && !this.dirtySessions.has(session.id)) return cached
    return this.recount(session)
  }

  /**
   * All surface nodes (model-visible order, oldest first) with payloads.
   * Indexed by seq: sessions grow to tens of thousands of events, and a
   * linear find per node would make every pre-step O(n²) (measured: 17.7s
   * on a 38k-event session). One O(n) index build per call. Only called on
   * the trigger path (every lightWindow rounds) and on recount — never on
   * the no-op hot path.
   */
  private surfaceNodes(session: import('@deepseek-ai/dsh-session').Session): SurfaceEntry[] {
    const bySeq = new Map<number, import('@deepseek-ai/dsh-session').SessionEvent>()
    for (const event of session.events) bySeq.set(event.seq, event)
    const out: SurfaceEntry[] = []
    for (const seq of session.surface.nodes) {
      const event = bySeq.get(seq)
      if (event === undefined) continue
      const message = deriveEventMessage(event)
      if (message === null) continue
      out.push({ seq, event, message })
    }
    return out
  }

  /**
   * Position-is-age zones: count user rounds from the tail (newest = 0);
   * each zone boundary snaps to a user round so assistant/tool messages stay
   * whole and tool pairing is never cut.
   */
  private computeZones(agent: Agent): Zones {
    const nodes = this.surfaceNodes(agent.session)
    const userIdx: number[] = []
    nodes.forEach((n, i) => { if (isUserRound(n.message)) userIdx.push(i) })
    const total = userIdx.length

    const { rawFrom, heavyFrom } = zoneBoundaries(total, this.mosaic.lightStart, this.mosaic.heavyStart)
    const rawStartIdx = userIdx[rawFrom] ?? nodes.length
    const heavyBoundaryIdx = userIdx[heavyFrom] ?? 0

    const light: SurfaceEntry[] = []
    for (let i = heavyBoundaryIdx; i < rawStartIdx && i < nodes.length; i++) {
      light.push(nodes[i])
    }
    const heavyEmpty = heavyBoundaryIdx <= 0 || heavyBoundaryIdx > nodes.length
    const heavy = heavyEmpty
      ? { start: 0, end: -1 }
      : { start: nodes[0].seq, end: nodes[heavyBoundaryIdx - 1].seq }

    return { light, heavy, heavyEmpty }
  }

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
  private async heavyFold(
    agent: Agent,
    startSeq: number,
    endSeq: number,
    signal: AbortSignal,
  ): Promise<CompactionResult> {
    const { session } = agent
    const nodes = this.surfaceNodes(session)
    const startIdx = nodes.findIndex(n => n.seq === startSeq)
    const endIdx = nodes.findIndex(n => n.seq === endSeq)
    if (startIdx < 0 || endIdx < 0) {
      throw new Error('mosaic-heavy: heavy range not found on surface')
    }
    const shadowed = nodes.slice(startIdx, endIdx + 1)

    // LLM input: user/assistant text only — strip tool noise entirely.
    const stripped = shadowed
      .map(n => this.textOnly(n.message))
      .filter(t => t.length > 0)
      .join('\n')
    if (stripped.length === 0) {
      throw new Error('mosaic-heavy: nothing left to summarize')
    }
    const summaryMessage = await this.summarize(
      { messages: [createUserMessage({
        content: [{ type: 'text', text: stripped }],
        source: { kind: 'plugin', plugin: 'dsh-mosaic-memory-compress' },
      })] },
      agent,
      signal,
    )
    const summaryText = summaryMessage.summary.map(b => b.type === 'text' ? b.text : '').join('').trim()

    const meter = this.ctx.get('tokenMeter') as { estimateMessage(m: Message): number } | undefined
    const shadowedTokenCount = meter
      ? shadowed.reduce((s, n) => s + meter.estimateMessage(n.message), 0)
      : 0

    const compactionId = randomUUID() as unknown as import('@deepseek-ai/dsh-compaction').CompactionId
    const turn = this.latestTurn(session)
    const shadowedSeqs = shadowed.map(n => n.seq)

    const startEv = session.append('compaction/start', { compactionId, turn })
    const summaryEv = session.append('compaction/summary', {
      compactionId,
      summary: [{ type: 'text', text: summaryText }],
      shadowedRange: { start: startSeq, end: endSeq },
      shadowedSeqs,
      shadowedTokenCount,
      provider: summaryMessage.provider,
      model: summaryMessage.model,
    })
    // DSH requires every user/assistant message to carry a non-empty
    // message.id ("identified message", enforced at session load). Factory
    // constructors assign the stable id — never hand-build message objects.
    const checkpointUser = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: summaryText }],
      source: { kind: 'plugin', plugin: 'dsh-mosaic-memory-compress' },
    }), {
      surfaceOp: { op: 'replace', start: startSeq, end: endSeq },
      sourceEventSeqs: shadowedSeqs,
    })
    const confirm = session.append('assistant/message', {
      turn,
      step: 0,
      message: createAssistantMessage({
        content: [{ type: 'text', text: '[MosaicMemory] ancient rounds folded into the checkpoint above; the summary pair is now the oldest memory layer.' }],
        source: {
          provider: summaryMessage.provider ?? 'unknown',
          model: summaryMessage.model ?? 'unknown',
        },
      }),
    } as never, { surfaceOp: 'append' })
    const endEv = session.append('compaction/end', { compactionId, turn })

    return {
      compactionId,
      startSeq: startEv.seq,
      summarySeq: summaryEv.seq,
      endSeq: endEv.seq,
      summary: [{ type: 'text', text: summaryText }],
      shadowedRange: { start: startSeq, end: endSeq },
      shadowedSeqs,
      shadowedTokenCount,
      provider: summaryMessage.provider,
      model: summaryMessage.model,
    } as never
  }

  /** Text-only rendering of a message: user/assistant text blocks; tool noise dropped. */
  private textOnly(message: Message): string {
    const role = message.role === 'assistant' ? 'assistant' : message.role === 'user' ? 'user' : null
    if (role === null) return ''
    const text = (message.content ?? [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join(' ')
      .trim()
    if (text.length === 0) return ''
    return role + ': ' + text
  }

  /** Latest turn number from the session log. */
  private latestTurn(session: import('@deepseek-ai/dsh-session').Session): number {
    let turn = 0
    for (const e of session.events) {
      if (e.type === 'turn/start') turn = e.data.turn
    }
    return turn
  }

  // ───────────────────────────────────────────────────────────────── light

  /**
   * Per-node 1:1 surface replacement over the light zone.
   * Pure structural truncation — synchronous, zero LLM calls.
   */
  private lightPass(
    agent: Agent,
    zone: SurfaceEntry[],
    _signal: AbortSignal,
  ): void {
    const { session } = agent
    const meter = this.ctx.get('tokenMeter') as { estimateMessage(m: Message): number } | undefined
    for (const entry of zone) {
      if (this.distilledSeqs.has(entry.seq)) continue
      const msg = entry.message
      this.lightStats.calls++
      this.lightStats.tokens += meter !== undefined ? meter.estimateMessage(entry.message) : 0
      const isInjection = msg.source.kind === 'plugin'
      const blocks = this.structuralTruncate(msg.content, isInjection)
      // Shadow-price protocol: emit compaction/prune BEFORE each replacement so
      // the context-usage projection reflects the truncation.
      if (meter !== undefined) {
        session.append('compaction/prune', {
          shadowedRange: { start: entry.seq, end: entry.seq },
          shadowedSeqs: [entry.seq],
          shadowedTokenCount: meter.estimateMessage(entry.message),
        })
      }
      const opts = {
        surfaceOp: { op: 'replace' as const, start: entry.seq, end: entry.seq },
        sourceEventSeqs: [entry.seq],
      }
      const data = entry.event.data as Record<string, unknown>
      let replacement
      if (msg.role === 'assistant') {
        // Keep tool-call blocks (pairing) intact; truncate the rest structurally.
        replacement = session.append('assistant/message', {
          turn: data.turn as number,
          step: data.step as number,
          ...data,
          message: { ...msg, content: blocks } as import('@deepseek-ai/dsh-llm').AssistantMessage,
        }, opts)
      } else if (msg.source.kind === 'tool') {
        replacement = session.append('tool/result', {
          turn: data.turn as number,
          step: data.step as number,
          ...data,
          message: { ...msg, content: blocks } as import('@deepseek-ai/dsh-llm').ToolResultMessage,
        }, opts)
      } else {
        replacement = session.append('user/message', {
          ...msg,
          content: blocks,
        } as import('@deepseek-ai/dsh-llm').UserMessage, opts)
      }
      this.distilledSeqs.add(replacement.seq)
    }
  }

  /**
   * Light pass is PURE STRUCTURAL TRUNCATION (zero LLM calls): real-surface
   * token composition is reasoning 33% + tool-call arguments 33% + tool
   * results 24% vs. text ~5% (measured 2026-08-16). Truncating the big
   * structured payloads yields ~46% net surface savings at zero cost.
   * All truncations API-verified safe with DeepSeek.
   */
  private structuralTruncate(blocks: ContentBlock[], isInjection: boolean): ContentBlock[] {
    return blocks.map(b => {
      if (b.type === 'reasoning') {
        if (b.text.length <= LIGHT_REASON_KEEP * 2 + 1) return b
        return { ...b, text: b.text.slice(0, LIGHT_REASON_KEEP) + '…' + b.text.slice(-LIGHT_REASON_KEEP) }
      }
      if (b.type === 'tool-call') {
        return { ...b, arguments: truncateArguments(b.arguments) }
      }
      if (b.type === 'tool-result' && Array.isArray(b.content)) {
        return {
          ...b,
          content: b.content.map(ib => ib.type === 'text' && ib.text.length > LIGHT_RESULT_HEAD + LIGHT_RESULT_TAIL
            ? { ...ib, text: ib.text.slice(0, LIGHT_RESULT_HEAD) + '\n…[truncated]…\n' + ib.text.slice(-LIGHT_RESULT_TAIL) }
            : ib),
        }
      }
      if (b.type === 'text' && isInjection && b.text.length > LIGHT_INJECT_MAX) {
        return { ...b, text: b.text.slice(0, LIGHT_INJECT_MAX) + '…' }
      }
      return b
    })
  }

  /** Routed provider/model: session request header, else agent options. */
  private llmTarget(agent: Agent): { provider: string; model: string } | undefined {
    const routed = agent.session.requestHeader()?.config
    if (routed !== undefined && (routed.provider ?? '') !== '' && (routed.model ?? '') !== '') {
      return { provider: routed.provider!, model: routed.model! }
    }
    if ((agent.options.provider ?? '') !== '' && (agent.options.model ?? '') !== '') {
      return { provider: agent.options.provider!, model: agent.options.model! }
    }
    return undefined
  }

  /**
   * Heavy checkpoint: official summarization machinery, mosaic instruction.
   * The replayed region includes the previous checkpoint node, so this is a
   * summary-of-summary by construction — bounded by maxTokens, never grows.
   */
  protected override async summarize(
    input: {
      system?: string
      tools?: readonly import('@deepseek-ai/dsh-llm').ToolSchema[]
      messages: readonly Message[]
    },
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<{
    summary: ContentBlock[]
    provider: string
    model: string
    maxTokens?: number
    usage?: import('@deepseek-ai/dsh-llm').TokenUsage
    rawOutput: ContentBlock[]
    llmStreamCall: true
  }> {
    const target = this.llmTarget(agent)
    if (target === undefined) {
      throw new Error('mosaic-heavy: no provider/model available for summarization')
    }
    const assembler = new BlockAssembler()
    const instruction = createUserMessage({
      content: [{ type: 'text', text: HEAVY_INSTRUCTION }],
      source: { kind: 'plugin', plugin: 'dsh-mosaic-memory-compress' },
    })
    const options: import('@deepseek-ai/dsh-llm').GenerateOptions = {
      provider: target.provider,
      model: target.model,
      messages: [...input.messages, instruction],
      ...(input.system === undefined ? {} : { system: input.system }),
      ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
      maxTokens: this.mosaic.maxTokens,
      sessionId: agent.session.id,
      purpose: 'compaction',
      ...(signal === undefined ? {} : { signal }),
    }
    for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk)
    const rawOutput = assembler.blocks()
    const summary = rawOutput.filter((b): b is TextBlock => b.type === 'text')
    if (summary.length === 0) {
      throw new Error('mosaic-heavy: summarization produced no text content')
    }
    return {
      summary,
      rawOutput,
      llmStreamCall: true,
      provider: target.provider,
      model: target.model,
      maxTokens: this.mosaic.maxTokens,
      ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
    }
  }
}

/** Cordis plugin entry. */
export function apply(ctx: Context, config: Partial<MosaicMemoryConfig> = {}): void {
  console.log('[mosaic-memory-compact] apply() called')
  ctx.plugin(MosaicMemoryCompactionEngine, config)
}

export default MosaicMemoryCompactionEngine
