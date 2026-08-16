/**
 * MosaicCompactionEngine — natural forgetting-curve compaction for DSH.
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

/** Zone thresholds in memory-round (user-message) units. */
export interface MosaicConfig {
  /** Most recent N memory rounds kept raw (default 30). */
  lightStart: number
  /** Anti-jitter: run compression every N rounds (default 10). */
  lightWindow: number
  /** Rounds older than this fold into the heavy checkpoint (default 50). */
  heavyStart: number
  /** Anti-jitter for the heavy fold (default 10). */
  heavyWindow: number
  /** Generation cap for one light distillation call (default 1024). */
  lightMaxTokens: number
  /**
   * Light distillation skips messages at or below this length (default 160):
   * no filler worth removing, no wasted LLM call, and distilled messages
   * naturally fall under it so repeated triggers don't re-distill.
   */
  lightSkipThreshold: number
  /** Generation cap for the heavy checkpoint (default 8192). */
  maxTokens: number
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
const DEFAULTS: Required<MosaicConfig> = {
  lightStart: 30,
  lightWindow: 10,
  heavyStart: 50,
  heavyWindow: 10,
  lightMaxTokens: 1024,
  lightSkipThreshold: 160,
  maxTokens: 8192,
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

export class MosaicCompactionEngine extends BasicCompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions']

  private readonly mosaic: Required<MosaicConfig>

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

  constructor(ctx: Context, config: Partial<MosaicConfig> = {}) {
    const mosaic: Required<MosaicConfig> = { ...DEFAULTS, ...config }
    if (mosaic.lightStart < 0 || mosaic.lightWindow <= 0
      || mosaic.heavyStart <= mosaic.lightStart || mosaic.heavyWindow <= 0) {
      throw new TypeError('mosaic: invalid zones (need 0 ≤ lightStart < heavyStart, windows > 0)')
    }
    super(ctx, { auto: true })
    this.mosaic = mosaic
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
    console.log('[mosaic-compact] engine constructed (lightStart=' + mosaic.lightStart
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
    const t0 = Date.now()
    this.lightStats = { calls: 0, tokens: 0 }
    const userCount = this.userRounds(agent.session)
    const offWindow = userCount % this.mosaic.lightWindow !== 0
    const belowThreshold = userCount < this.mosaic.lightStart
    if (trigger !== 'context-overflow' && (belowThreshold || offWindow)) {
      console.log('[mosaic] pre-step sid=' + agent.session.id.slice(0, 8)
        + ' R=' + userCount + ' trigger=' + trigger
        + ' no-op (' + (Date.now() - t0) + 'ms)')
      return null
    }

    const zones = this.computeZones(agent)

    // Light first: 1:1 replacements keep the surface structure (count, roles,
    // pairing) intact, so the heavy range computed before remains valid.
    if (zones.light.length > 0) {
      await this.lightPass(agent, zones.light, signal)
    }

    // Heavy second: the official transaction folds the ancient region into
    // one bounded checkpoint node (incremental by construction — the previous
    // checkpoint is inside the range and gets re-summarized).
    if (!zones.heavyEmpty && userCount >= this.mosaic.heavyStart) {
      const result = await this.compactRegion(zones.heavy.start, zones.heavy.end, agent, signal)
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

  // ───────────────────────────────────────────────────────────────── light

  /** Per-node 1:1 surface replacement over the light zone (concurrent like the library). */
  private async lightPass(
    agent: Agent,
    zone: SurfaceEntry[],
    signal: AbortSignal,
  ): Promise<void> {
    const { session } = agent
    // Incremental: nodes distilled by an earlier trigger are skipped.
    const fresh = zone.filter(entry => !this.distilledSeqs.has(entry.seq))
    // Distill all fresh messages concurrently (library semantics: Promise.all);
    // each failure independently keeps its original verbatim.
    const distilledTexts = await Promise.all(fresh.map(entry => this.distill(entry.message, agent, signal)))
    const meter = this.ctx.get('tokenMeter') as { estimateMessage(m: Message): number } | undefined
    for (let i = 0; i < fresh.length; i++) {
      const entry = fresh[i]
      const distilled = distilledTexts[i]
      if (distilled === null) continue // failure keeps the original verbatim
      const textBlock: TextBlock = { type: 'text', text: distilled }
      // Shadow-price protocol (official): a replacement without a claim keeps
      // the token-meter's surface total unchanged, so the context-usage
      // figure would ignore light distillation. Emit compaction/prune BEFORE
      // each replacement — the meter subtracts the shadowed price from
      // surfaceTokens and the context-pressure projection drops accordingly.
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
      const msg = entry.message
      let replacement
      if (msg.role === 'assistant') {
        // Keep tool-call blocks (pairing) intact; distill only the text.
        const blocks = [...msg.content.filter(b => b.type !== 'text'), textBlock]
        replacement = session.append('assistant/message', {
          turn: data.turn as number,
          step: data.step as number,
          ...data,
          message: { ...msg, content: blocks } as import('@deepseek-ai/dsh-llm').AssistantMessage,
        }, opts)
      } else if (msg.source.kind === 'tool') {
        // Tool result: replace the payload blocks inside the tool-result block.
        const block = msg.content.find(b => b.type === 'tool-result')
        if (block === undefined || block.type !== 'tool-result') continue
        replacement = session.append('tool/result', {
          turn: data.turn as number,
          step: data.step as number,
          ...data,
          message: { ...msg, content: [{ ...block, content: [textBlock] }] } as import('@deepseek-ai/dsh-llm').ToolResultMessage,
        }, opts)
      } else {
        replacement = session.append('user/message', {
          ...msg,
          content: [textBlock],
        } as import('@deepseek-ai/dsh-llm').UserMessage, opts)
      }
      this.distilledSeqs.add(replacement.seq)
    }
  }

  /**
   * One message → distilled plain text, or null to keep the original.
   * One small LLM call per message (library semantics); any failure keeps
   * the original verbatim — compression never blocks the conversation.
   */
  private async distill(
    message: Message,
    agent: Agent,
    signal: AbortSignal,
  ): Promise<string | null> {
    const text = this.textOf(message)
    // No meaningful content (empty / placeholder-only / already terse):
    // keep verbatim, zero LLM calls — also makes repeated triggers cheap.
    if (text.trim().length <= this.mosaic.lightSkipThreshold) return null
    try {
      const distilled = await this.distillWithLlm(message, agent, signal)
      return distilled.length > 0 ? distilled : null
    } catch {
      return null // keep the original verbatim
    }
  }

  /** One small per-message call, plain-text output. */
  private async distillWithLlm(
    message: Message,
    agent: Agent,
    signal: AbortSignal,
  ): Promise<string> {
    const text = this.textOf(message)
    const target = this.llmTarget(agent)
    if (target === undefined) throw new Error('mosaic-light: no provider/model available')
    const messages = [
      createUserMessage({
        content: [{ type: 'text', text: 'Dehydrate this conversation message: '
          + 'keep the intent and key facts, drop filler and reasoning. '
          + 'Output plain text only. If it is already terse, return it unchanged.' }],
        source: { kind: 'plugin', plugin: 'dsh-mosaic-compress' },
      }),
      createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'dsh-mosaic-compress' },
      }),
    ]
    let out = ''
    for await (const chunk of this.ctx.llm.stream({
      provider: target.provider,
      model: target.model,
      messages,
      maxTokens: this.mosaic.lightMaxTokens,
      sessionId: agent.session.id,
      purpose: 'compaction',
      ...(signal === undefined ? {} : { signal }),
    })) {
      if (chunk.type === 'text-delta') out += chunk.text
      else if (chunk.type === 'usage') {
        this.lightStats.calls++
        const u = chunk.usage
        this.lightStats.tokens += (u ? (u.inputTokens ?? 0) + (u.outputTokens ?? 0) : 0)
      }
    }
    return out.trim()
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

  /** Flatten message content blocks to plain text (tool-call args included). */
  private textOf(message: Message): string {
    const parts: string[] = []
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          parts.push(block.text)
          break
        case 'tool-result':
          parts.push(block.content.map(b => b.type === 'text' ? b.text : '').filter(Boolean).join('\n'))
          break
        case 'tool-call':
          parts.push(block.name + ' ' + block.arguments)
          break
        case 'reasoning':
          break // stripped by design
      }
    }
    return parts.join('\n')
  }

  // ───────────────────────────────────────────────────────────────── heavy

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
      source: { kind: 'plugin', plugin: 'dsh-mosaic-compress' },
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
export function apply(ctx: Context, config: Partial<MosaicConfig> = {}): void {
  console.log('[mosaic-compact] apply() called')
  ctx.plugin(MosaicCompactionEngine, config)
}

export default MosaicCompactionEngine
