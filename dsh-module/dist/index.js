// src/index.ts
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import {
  BlockAssembler,
  createUserMessage
} from "@deepseek-ai/dsh-llm";
import { deriveEventMessage, isSurfaceEvent } from "@deepseek-ai/dsh-session";

// src/zones.ts
function zoneBoundaries(userCount, lightStart, heavyStart) {
  return {
    rawFrom: Math.max(0, userCount - lightStart),
    heavyFrom: Math.max(0, userCount - heavyStart)
  };
}

// src/index.ts
var LIGHT_REASON_KEEP = 30;
var LIGHT_ARG_FIELD_MAX = 120;
var LIGHT_RESULT_HEAD = 50;
var LIGHT_RESULT_TAIL = 50;
var LIGHT_INJECT_MAX = 30;
function truncateArguments(raw) {
  try {
    const walk = (v) => {
      if (typeof v === "string") return v.length > LIGHT_ARG_FIELD_MAX ? v.slice(0, LIGHT_ARG_FIELD_MAX) + "\u2026[truncated]" : v;
      if (Array.isArray(v)) return v.slice(0, 3).map(walk);
      if (v !== null && typeof v === "object") {
        const out = {};
        for (const k of Object.keys(v)) out[k] = walk(v[k]);
        return out;
      }
      return v;
    };
    return JSON.stringify(walk(JSON.parse(raw)));
  } catch {
    return raw.length > LIGHT_ARG_FIELD_MAX ? raw.slice(0, LIGHT_ARG_FIELD_MAX) + "\u2026[truncated]" : raw;
  }
}
var HEAVY_INSTRUCTION = `You are a dialogue memory compressor. The recent
rounds of this conversation stay verbatim; your job is to condense only the
ANCIENT part below into one compact memory node that preserves what must
survive forgetting.

## Principles
1. You decide what is worth keeping \u2014 key decisions, preferences, creative
   directions, unfinished action items, lessons. Ancient, redundant
   information already covered by later conversation may be omitted.
2. Use declarative facts, one per line.
3. Preserve unfinished action items that need follow-up.
4. Preserve the original language of the input. Keep it terse.`;
var DEFAULTS = {
  lightStart: 10,
  lightWindow: 30,
  heavyStart: 30,
  heavyWindow: 30,
  maxTokens: 8192
};
function isUserRound(message) {
  return message.role === "user" && message.source.kind === "user";
}
var MosaicMemoryCompactionEngine = class extends BasicCompactionEngine {
  static inject = ["llm", "tokenMeter", "sessions"];
  mosaic;
  /**
   * Surface seqs already light-distilled by an earlier trigger. Incremental
   * semantics: light never re-distills the same node, matching the library's
   * _distilled marker. In-memory only — after a host restart the next trigger
   * re-distills once (correct, just one extra pass).
   */
  distilledSeqs = /* @__PURE__ */ new Set();
  /** Per-pre-step light statistics for the journal diagnostics. */
  lightStats = { calls: 0, tokens: 0 };
  /**
   * Window-level dedup: R stays on a window boundary across the steps of one
   * turn (pre-step runs per step), so without this guard the same round
   * would re-trigger full distillation for every step. One trigger per round.
   */
  lastTriggeredRound = -1;
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
  roundCounts = /* @__PURE__ */ new Map();
  dirtySessions = /* @__PURE__ */ new Set();
  constructor(ctx, config = {}) {
    const mosaic = { ...DEFAULTS, ...config };
    if (mosaic.lightStart < 0 || mosaic.lightWindow <= 0 || mosaic.heavyStart <= mosaic.lightStart || mosaic.heavyWindow <= 0) {
      throw new TypeError("mosaic: invalid zones (need 0 \u2264 lightStart < heavyStart, windows > 0)");
    }
    super(ctx, { auto: true });
    this.mosaic = mosaic;
    ctx.on("session/event", (session, event) => {
      if (!isSurfaceEvent(event)) return;
      const op = event.surfaceOp;
      if (event.type === "user/message" && op === "append" && event.data?.source?.kind === "user") {
        const c = this.roundCounts.get(session.id);
        if (c !== void 0) this.roundCounts.set(session.id, c + 1);
      } else if (op !== "append" && op.op === "replace" && op.start !== op.end) {
        this.dirtySessions.add(session.id);
      }
    });
    console.log("[mosaic-memory-compact] engine constructed (lightStart=" + mosaic.lightStart + ", heavyStart=" + mosaic.heavyStart + ")");
  }
  // ─────────────────────────────────────────────────────────────── trigger
  /**
   * Anti-jitter trigger on the user-round count. Returns null (zero cost)
   * below threshold or off-window. context-overflow forces a run.
   */
  async compactIfNeeded(agent, trigger, signal) {
    const t0 = Date.now();
    this.lightStats = { calls: 0, tokens: 0 };
    const userCount = this.userRounds(agent.session);
    const offWindow = userCount % this.mosaic.lightWindow !== 0;
    const belowThreshold = userCount < this.mosaic.lightStart;
    const alreadyTriggered = userCount === this.lastTriggeredRound;
    if (trigger !== "context-overflow" && (belowThreshold || offWindow || alreadyTriggered)) {
      console.log("[mosaic] pre-step sid=" + agent.session.id.slice(0, 8) + " R=" + userCount + " trigger=" + trigger + (alreadyTriggered ? " dedup" : "") + " no-op (" + (Date.now() - t0) + "ms)");
      return null;
    }
    this.lastTriggeredRound = userCount;
    const zones = this.computeZones(agent);
    if (zones.light.length > 0) {
      await this.lightPass(agent, zones.light, signal);
    }
    if (!zones.heavyEmpty && userCount >= this.mosaic.heavyStart) {
      const result = await this.compactRegion(zones.heavy.start, zones.heavy.end, agent, signal);
      console.log("[mosaic] pre-step sid=" + agent.session.id.slice(0, 8) + " R=" + userCount + " trigger=" + trigger + " TRIGGERED lightCalls=" + this.lightStats.calls + " lightTokens=" + this.lightStats.tokens + " heavyFolded=" + result.shadowedSeqs.length + " nodes (" + (Date.now() - t0) + "ms)");
      return result;
    }
    console.log("[mosaic] pre-step sid=" + agent.session.id.slice(0, 8) + " R=" + userCount + " trigger=" + trigger + " TRIGGERED lightCalls=" + this.lightStats.calls + " lightTokens=" + this.lightStats.tokens + " heavy=none (below heavyStart) (" + (Date.now() - t0) + "ms)");
    return null;
  }
  // ───────────────────────────────────────────────────────────────── zones
  /** Memory rounds = genuine user messages on the surface. */
  countUserRounds(session) {
    return this.surfaceNodes(session).filter((n) => isUserRound(n.message)).length;
  }
  /** Full recount (O(n)): rebuild the per-session counter from the live surface. */
  recount(session) {
    const count = this.countUserRounds(session);
    this.roundCounts.set(session.id, count);
    this.dirtySessions.delete(session.id);
    return count;
  }
  /** O(1) read with lazy init and dirty-session fallback. */
  userRounds(session) {
    const cached = this.roundCounts.get(session.id);
    if (cached !== void 0 && !this.dirtySessions.has(session.id)) return cached;
    return this.recount(session);
  }
  /**
   * All surface nodes (model-visible order, oldest first) with payloads.
   * Indexed by seq: sessions grow to tens of thousands of events, and a
   * linear find per node would make every pre-step O(n²) (measured: 17.7s
   * on a 38k-event session). One O(n) index build per call. Only called on
   * the trigger path (every lightWindow rounds) and on recount — never on
   * the no-op hot path.
   */
  surfaceNodes(session) {
    const bySeq = /* @__PURE__ */ new Map();
    for (const event of session.events) bySeq.set(event.seq, event);
    const out = [];
    for (const seq of session.surface.nodes) {
      const event = bySeq.get(seq);
      if (event === void 0) continue;
      const message = deriveEventMessage(event);
      if (message === null) continue;
      out.push({ seq, event, message });
    }
    return out;
  }
  /**
   * Position-is-age zones: count user rounds from the tail (newest = 0);
   * each zone boundary snaps to a user round so assistant/tool messages stay
   * whole and tool pairing is never cut.
   */
  computeZones(agent) {
    const nodes = this.surfaceNodes(agent.session);
    const userIdx = [];
    nodes.forEach((n, i) => {
      if (isUserRound(n.message)) userIdx.push(i);
    });
    const total = userIdx.length;
    const { rawFrom, heavyFrom } = zoneBoundaries(total, this.mosaic.lightStart, this.mosaic.heavyStart);
    const rawStartIdx = userIdx[rawFrom] ?? nodes.length;
    const heavyBoundaryIdx = userIdx[heavyFrom] ?? 0;
    const light = [];
    for (let i = heavyBoundaryIdx; i < rawStartIdx && i < nodes.length; i++) {
      light.push(nodes[i]);
    }
    const heavyEmpty = heavyBoundaryIdx <= 0 || heavyBoundaryIdx > nodes.length;
    const heavy = heavyEmpty ? { start: 0, end: -1 } : { start: nodes[0].seq, end: nodes[heavyBoundaryIdx - 1].seq };
    return { light, heavy, heavyEmpty };
  }
  // ───────────────────────────────────────────────────────────────── light
  /**
   * Per-node 1:1 surface replacement over the light zone.
   * Pure structural truncation — synchronous, zero LLM calls.
   */
  lightPass(agent, zone, _signal) {
    const { session } = agent;
    const meter = this.ctx.get("tokenMeter");
    for (const entry of zone) {
      if (this.distilledSeqs.has(entry.seq)) continue;
      const msg = entry.message;
      const isInjection = msg.source.kind === "plugin";
      const blocks = this.structuralTruncate(msg.content, isInjection);
      if (meter !== void 0) {
        session.append("compaction/prune", {
          shadowedRange: { start: entry.seq, end: entry.seq },
          shadowedSeqs: [entry.seq],
          shadowedTokenCount: meter.estimateMessage(entry.message)
        });
      }
      const opts = {
        surfaceOp: { op: "replace", start: entry.seq, end: entry.seq },
        sourceEventSeqs: [entry.seq]
      };
      const data = entry.event.data;
      let replacement;
      if (msg.role === "assistant") {
        replacement = session.append("assistant/message", {
          turn: data.turn,
          step: data.step,
          ...data,
          message: { ...msg, content: blocks }
        }, opts);
      } else if (msg.source.kind === "tool") {
        replacement = session.append("tool/result", {
          turn: data.turn,
          step: data.step,
          ...data,
          message: { ...msg, content: blocks }
        }, opts);
      } else {
        replacement = session.append("user/message", {
          ...msg,
          content: blocks
        }, opts);
      }
      this.distilledSeqs.add(replacement.seq);
    }
  }
  /**
   * Light pass is PURE STRUCTURAL TRUNCATION (zero LLM calls): real-surface
   * token composition is reasoning 33% + tool-call arguments 33% + tool
   * results 24% vs. text ~5% (measured 2026-08-16). Truncating the big
   * structured payloads yields ~46% net surface savings at zero cost.
   * All truncations API-verified safe with DeepSeek.
   */
  structuralTruncate(blocks, isInjection) {
    return blocks.map((b) => {
      if (b.type === "reasoning") {
        if (b.text.length <= LIGHT_REASON_KEEP * 2 + 1) return b;
        return { ...b, text: b.text.slice(0, LIGHT_REASON_KEEP) + "\u2026" + b.text.slice(-LIGHT_REASON_KEEP) };
      }
      if (b.type === "tool-call") {
        return { ...b, arguments: truncateArguments(b.arguments) };
      }
      if (b.type === "tool-result" && Array.isArray(b.content)) {
        return {
          ...b,
          content: b.content.map((ib) => ib.type === "text" && ib.text.length > LIGHT_RESULT_HEAD + LIGHT_RESULT_TAIL ? { ...ib, text: ib.text.slice(0, LIGHT_RESULT_HEAD) + "\n\u2026[truncated]\u2026\n" + ib.text.slice(-LIGHT_RESULT_TAIL) } : ib)
        };
      }
      if (b.type === "text" && isInjection && b.text.length > LIGHT_INJECT_MAX) {
        return { ...b, text: b.text.slice(0, LIGHT_INJECT_MAX) + "\u2026" };
      }
      return b;
    });
  }
  /** Routed provider/model: session request header, else agent options. */
  llmTarget(agent) {
    const routed = agent.session.requestHeader()?.config;
    if (routed !== void 0 && (routed.provider ?? "") !== "" && (routed.model ?? "") !== "") {
      return { provider: routed.provider, model: routed.model };
    }
    if ((agent.options.provider ?? "") !== "" && (agent.options.model ?? "") !== "") {
      return { provider: agent.options.provider, model: agent.options.model };
    }
    return void 0;
  }
  /**
   * Heavy checkpoint: official summarization machinery, mosaic instruction.
   * The replayed region includes the previous checkpoint node, so this is a
   * summary-of-summary by construction — bounded by maxTokens, never grows.
   */
  async summarize(input, agent, signal) {
    const target = this.llmTarget(agent);
    if (target === void 0) {
      throw new Error("mosaic-heavy: no provider/model available for summarization");
    }
    const assembler = new BlockAssembler();
    const instruction = createUserMessage({
      content: [{ type: "text", text: HEAVY_INSTRUCTION }],
      source: { kind: "plugin", plugin: "dsh-mosaic-memory-compress" }
    });
    const options = {
      provider: target.provider,
      model: target.model,
      messages: [...input.messages, instruction],
      ...input.system === void 0 ? {} : { system: input.system },
      ...input.tools === void 0 ? {} : { tools: [...input.tools] },
      maxTokens: this.mosaic.maxTokens,
      sessionId: agent.session.id,
      purpose: "compaction",
      ...signal === void 0 ? {} : { signal }
    };
    for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk);
    const rawOutput = assembler.blocks();
    const summary = rawOutput.filter((b) => b.type === "text");
    if (summary.length === 0) {
      throw new Error("mosaic-heavy: summarization produced no text content");
    }
    return {
      summary,
      rawOutput,
      llmStreamCall: true,
      provider: target.provider,
      model: target.model,
      maxTokens: this.mosaic.maxTokens,
      ...assembler.usage === void 0 ? {} : { usage: assembler.usage }
    };
  }
};
function apply(ctx, config = {}) {
  console.log("[mosaic-memory-compact] apply() called");
  ctx.plugin(MosaicMemoryCompactionEngine, config);
}
var index_default = MosaicMemoryCompactionEngine;
export {
  MosaicMemoryCompactionEngine,
  apply,
  index_default as default
};
//# sourceMappingURL=index.js.map