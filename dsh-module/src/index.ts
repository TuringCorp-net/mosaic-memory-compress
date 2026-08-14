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
import { deriveEventMessage } from '@deepseek-ai/dsh-session'
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
  /**
   * Light distillation mode:
   * - 'rules': zero-LLM-cost programmatic dehydration (compress oversized
   *   tool results, keep everything else verbatim).
   * - 'llm': per-message distillation, one small call per message, plain
   *   text output, failure keeps the original (never batch — learned from
   *   the batched-call truncation failure).
   */
  lightDistillMode: 'rules' | 'llm'
  /** Generation cap for one llm-mode distillation call (default 1024). */
  lightMaxTokens: number
  /** Generation cap for the heavy checkpoint (default 8192). */
  maxTokens: number
}

/** Rules-only dehydrator: zero LLM cost, zero semantic risk. */
const RULES_TOOL_KEEP_HEAD = 300
const RULES_TOOL_KEEP_TAIL = 200
const RULES_TOOL_MAX = 1500

/** Heavy-zone checkpoint instruction: semantic memory, not event replay. */
const HEAVY_INSTRUCTION = `You are consolidating the ANCIENT part of a conversation
into a compact SEMANTIC MEMORY node (the recent rounds stay verbatim; this
node only holds what must survive forgetting).

Keep ONLY:
1. Identity and environment facts (who/what/where, access, permissions).
2. Hard rules and red lines (what must never be done without approval).
3. Project anchors (repos, paths, credentials locations, git identities).
4. Lessons that must persist (known failure modes and their fixes).
5. The current goal / next-step gist, one line each.

Drop: event narratives, tool outputs, numbers that live in code or docs,
anything recoverable from files or logs. Write terse bullets.`

/** Defaults mirror the library's DEFAULT_CONFIG. */
const DEFAULTS: Required<MosaicConfig> = {
  lightStart: 30,
  lightWindow: 10,
  heavyStart: 50,
  heavyWindow: 10,
  lightDistillMode: 'rules',
  lightMaxTokens: 1024,
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

/** Whether a message is a genuine user round (not a tool result). */
function isUserRound(message: Message): boolean {
  return message.role === 'user' && message.source.kind !== 'tool'
}

export class MosaicCompactionEngine extends BasicCompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions']

  private readonly mosaic: Required<MosaicConfig>

  constructor(ctx: Context, config: Partial<MosaicConfig> = {}) {
    const mosaic: Required<MosaicConfig> = { ...DEFAULTS, ...config }
    if (mosaic.lightStart < 0 || mosaic.lightWindow <= 0
      || mosaic.heavyStart <= mosaic.lightStart || mosaic.heavyWindow <= 0) {
      throw new TypeError('mosaic: invalid zones (need 0 ≤ lightStart < heavyStart, windows > 0)')
    }
    super(ctx, { auto: true })
    this.mosaic = mosaic
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
    const userCount = this.countUserRounds(agent)
    const offWindow = userCount % this.mosaic.lightWindow !== 0
    const belowThreshold = userCount < this.mosaic.lightStart
    if (trigger !== 'context-overflow' && (belowThreshold || offWindow)) return null

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
      return this.compactRegion(zones.heavy.start, zones.heavy.end, agent, signal)
    }
    return null
  }

  // ───────────────────────────────────────────────────────────────── zones

  /** Memory rounds = genuine user messages on the surface. */
  private countUserRounds(agent: Agent): number {
    return this.surfaceNodes(agent).filter(n => isUserRound(n.message)).length
  }

  /** All surface nodes (model-visible order, oldest first) with payloads. */
  private surfaceNodes(agent: Agent): SurfaceEntry[] {
    const out: SurfaceEntry[] = []
    for (const seq of agent.session.surface.nodes) {
      const event = agent.session.events.find(e => e.seq === seq)
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
    const nodes = this.surfaceNodes(agent)
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

  /** Per-node 1:1 surface replacement over the light zone. */
  private async lightPass(
    agent: Agent,
    zone: SurfaceEntry[],
    signal: AbortSignal,
  ): Promise<void> {
    const { session } = agent
    for (const entry of zone) {
      const distilled = await this.distill(entry.message, agent, signal)
      if (distilled === null) continue // failure keeps the original verbatim
      const textBlock: TextBlock = { type: 'text', text: distilled }
      const opts = {
        surfaceOp: { op: 'replace' as const, start: entry.seq, end: entry.seq },
        sourceEventSeqs: [entry.seq],
      }
      const data = entry.event.data as Record<string, unknown>
      const msg = entry.message
      if (msg.role === 'assistant') {
        // Keep tool-call blocks (pairing) intact; distill only the text.
        const blocks = [...msg.content.filter(b => b.type !== 'text'), textBlock]
        session.append('assistant/message', {
          turn: data.turn as number,
          step: data.step as number,
          ...data,
          message: { ...msg, content: blocks } as import('@deepseek-ai/dsh-llm').AssistantMessage,
        }, opts)
      } else if (msg.source.kind === 'tool') {
        // Tool result: replace the payload blocks inside the tool-result block.
        const block = msg.content.find(b => b.type === 'tool-result')
        if (block === undefined || block.type !== 'tool-result') continue
        session.append('tool/result', {
          turn: data.turn as number,
          step: data.step as number,
          ...data,
          message: { ...msg, content: [{ ...block, content: [textBlock] }] } as import('@deepseek-ai/dsh-llm').ToolResultMessage,
        }, opts)
      } else {
        session.append('user/message', {
          ...msg,
          content: [textBlock],
        } as import('@deepseek-ai/dsh-llm').UserMessage, opts)
      }
    }
  }

  /**
   * One message → distilled plain text, or null to keep the original.
   * llm mode degrades to rules mode on any failure (never truncates).
   */
  private async distill(
    message: Message,
    agent: Agent,
    signal: AbortSignal,
  ): Promise<string | null> {
    const text = this.textOf(message)
    if (this.mosaic.lightDistillMode === 'llm' && message.source.kind !== 'tool') {
      try {
        const distilled = await this.distillWithLlm(message, agent, signal)
        if (distilled.length > 0) return distilled
      } catch {
        // fall through to rules mode
      }
    }
    return this.distillRules(message, text)
  }

  /** rules mode: zero LLM cost, zero semantic risk. */
  private distillRules(message: Message, text: string): string | null {
    if (message.source.kind === 'tool' && text.length > RULES_TOOL_MAX) {
      const head = text.slice(0, RULES_TOOL_KEEP_HEAD)
      const tail = text.slice(-RULES_TOOL_KEEP_TAIL)
      return head + '\n…[payload distilled; original kept in shadowed log]…\n' + tail
    }
    // User/assistant text and short tool results stay verbatim — losing words
    // costs more than keeping them.
    return null
  }

  /** llm mode: one small per-message call, plain-text output. */
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
  ctx.plugin(MosaicCompactionEngine, config)
}

export default MosaicCompactionEngine
