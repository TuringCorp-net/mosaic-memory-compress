/**
 * MosaicCompress — Deterministic Mechanism Simulation (benchmark/simulate.ts)
 *
 * Runs the REAL mosaicCompress implementation with a RULE-BASED pseudo-LLM
 * (zero cost, fully reproducible with fixed seeds) to answer mechanism-level
 * questions that do NOT need a real model:
 *
 *   1. Steady state: is the message count really constant at
 *      100 / 500 / 1000 / 5000 rounds?  (pure dialogue → 102 msgs)
 *   2. Token curve: does estimated token usage converge?
 *   3. Information retention: planted facts (FACT-<id>) — where do they
 *      survive (raw / light / heavy) and where are they forgotten?
 *
 * The pseudo-LLM is deliberately "perfect" (retains all planted facts) so
 * that ANY loss measured here is caused by the ALGORITHM, not by LLM
 * imperfection. A later real-LLM spot check (small sample) calibrates this.
 *
 * Usage:
 *   npm run bench                       → synthetic conversation sweep
 *   npm run bench -- --file chat.json   → analyze YOUR OWN message file
 *
 * File format (JSON array of Message objects, same shape as the library):
 *   [{"role":"system","content":"..."},{"role":"user","content":"..."}, ...]
 * Reports original vs compressed message count, token estimates and the
 * compression ratio, using the same deterministic pseudo-LLM (no API cost).
 */

import * as fs from 'node:fs';
import { mosaicCompress, type MosaicConfig, type Message } from '../src/index';

// ============================================================
// Knobs
// ============================================================
const TOOL_ROUND_RATE = 0.15;      // ~15% of rounds contain a tool call
const REASONING_RATE = 0.3;        // ~30% of assistant replies carry reasoning_content
const FACT_EVERY = 20;             // plant one fact every N rounds
const FACT_RETENTION = 1.0;        // pseudo-compressor fact retention (1 = perfect)
// Default simulated summary budget. Real output windows: DeepSeek V4 up to
// 384K, Claude/Gemini ~64K, GPT 16-64K — a 1.5K summary budget is unrealistically
// small. 16K keeps summaries bounded while retaining far more facts.
const DEFAULT_HEAVY_BUDGET = 16384;

// Budget sweep values (tokens) — shows the retention-vs-steady-state tradeoff.
const BUDGET_SWEEP = [2048, 8192, 16384, 32768, 131072];

// ============================================================
// Deterministic PRNG (mulberry32) — results are reproducible
// ============================================================
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const factRng = mulberry32(20260814); // fixed seed so retention<1 stays reproducible

// ============================================================
// Token estimation (rough: CJK ~1 token/char, ASCII ~1 token/4 chars)
// ============================================================
function estTokens(m: Message): number {
  let t = 0;
  for (const ch of m.content || '') t += ch.charCodeAt(0) > 127 ? 1 : 0.25;
  if (m.reasoning_content) for (const ch of m.reasoning_content) t += ch.charCodeAt(0) > 127 ? 1 : 0.25;
  if (m.tool_calls) t += JSON.stringify(m.tool_calls).length * 0.3;
  return Math.max(1, Math.round(t));
}
function totalTokens(msgs: Message[]): number {
  return msgs.reduce((s, m) => s + estTokens(m), 0);
}

// ============================================================
// Fact ledger: every planted fact maps round -> text
// ============================================================
const FACTS: Map<number, string> = new Map();
let factCounter = 0;
function plantFact(round: number, content: string): string {
  factCounter++;
  const tag = 'FACT-' + factCounter;
  FACTS.set(round, tag + ': ' + content);
  return tag + ': ' + content;
}

// ============================================================
// Conversation generator (realistic: small talk + facts + tool calls)
// ============================================================
const FILE_SNIPPETS = [
  'export async function handleRequest(req: Request): Promise<Response> {\n  const url = new URL(req.url);\n  const params = url.searchParams;\n  const query = params.get("q") || "";\n  const results = await searchIndex.lookup(query, { limit: 20, fuzzy: true });\n  return Response.json({ ok: true, count: results.length, items: results });\n}',
  'class VectorStore {\n  private vectors: Float32Array[] = [];\n  private meta: Record<number, { id: string; source: string }> = {};\n  async add(id: string, vector: Float32Array, source: string) {\n    this.vectors.push(vector);\n    this.meta[this.vectors.length - 1] = { id, source };\n  }\n  async search(q: Float32Array, k = 10) {\n    // cosine similarity over this.vectors, return top-k indices\n  }\n}',
  'function parseMarkdown(src: string): Node[] {\n  const tokens = lex(src);\n  const nodes: Node[] = [];\n  let i = 0;\n  while (i < tokens.length) {\n    if (tokens[i].type === "heading") {\n      nodes.push(parseHeading(tokens, i)); i += 3;\n    } else if (tokens[i].type === "fence") {\n      nodes.push(parseFence(tokens, i)); i += 2;\n    } else { i++; }\n  }\n  return nodes;\n}',
];
const WEB_SNIPPETS = [
  'According to the docs, the API returns a paginated response: { "data": [...], "next_cursor": "abc123" }. Rate limits are 60 req/min for free tier and 600 req/min for pro. Authentication uses a Bearer token in the Authorization header.',
  'The benchmark results show qwen2.5-72b achieving 78.3% on the long-context retrieval task, while the 7b variant drops to 52.1%. Memory usage scales linearly with sequence length, peaking at 4.2GB for 128K tokens.',
  'The repository README states the project is MIT licensed, supports Node >= 20, and recommends pnpm. The build pipeline runs typecheck, unit tests, and a bundle-size check in CI. Releases are tagged with semantic versioning.',
];
const USER_FILLERS = [
  '嗯，我大概明白了，你继续说。',
  '这个思路可以，那我们再看看下一步。',
  '好的，我同意，先这样定。',
  '有道理，不过我想再确认一个细节。',
  '行，就按这个方向推进。',
];
const ASSISTANT_REPLIES = [
  '好的，我整理一下：核心思路是保持接口不变，内部实现分三层，每层职责单一，边界用类型收口。你看这个划分是否合理？',
  '确认收到。我的建议是先落地最小可用版本，把链路打通，然后再逐步优化性能，避免过早抽象。',
  '这里我补充一个考虑：异步场景下要注意竞态问题，建议用单一数据源加版本号校验，这样并发写入不会互相覆盖。',
  '明白了，那么下一步我会：1) 梳理现有接口签名；2) 补充边界测试；3) 跑一遍回归。有结论随时同步。',
  '这个方案技术上可行，成本上也能接受。唯一要留意的是冷启动延迟，建议加上预热机制和降级开关。',
];

function makeConversation(rounds: number, rng: () => number): Message[] {
  const msgs: Message[] = [{ role: 'system', content: 'You are MosaicBench, a helpful engineering assistant. Be concise but thorough.' }];
  for (let r = 1; r <= rounds; r++) {
    let userText = USER_FILLERS[Math.floor(rng() * USER_FILLERS.length)];
    if (r % FACT_EVERY === 0) {
      const topics = [
        '用户决定数据库选用 PostgreSQL，迁移时间为下周一',
        '用户偏好 TypeScript strict 模式，拒绝 any',
        '用户确认定价方案为按量计费，月封顶 50 美元',
        '用户要求日志保留 90 天，敏感字段脱敏',
        '用户选定 UI 采用深色主题，字体使用 Inter',
        '用户确定部署到 us-east-1，配合 CloudFront 边缘缓存',
      ];
      const topic = topics[Math.floor(rng() * topics.length)];
      userText += ' 对了，' + plantFact(r, topic);
    }
    msgs.push({ role: 'user', content: userText });

    const reply: Message = { role: 'assistant', content: ASSISTANT_REPLIES[Math.floor(rng() * ASSISTANT_REPLIES.length)] };
    if (rng() < REASONING_RATE) {
      reply.reasoning_content = '思考：用户提到的核心约束是' + (r % FACT_EVERY === 0 ? '新确定的事实' : '既有上下文') + '，需要在回复中确认并给出可执行建议。';
    }
    msgs.push(reply);

    if (rng() < TOOL_ROUND_RATE) {
      const isCode = rng() < 0.5;
      const name = isCode ? 'read_file' : 'search_web';
      const args = isCode
        ? JSON.stringify({ path: 'src/core/' + ['store.ts', 'parser.ts', 'api.ts'][Math.floor(rng() * 3)] })
        : JSON.stringify({ query: 'long-context benchmark ' + Math.floor(rng() * 100) });
      msgs.push({
        role: 'assistant',
        content: isCode ? '我先读一下相关源码再回答。' : '我查一下相关文档。',
        tool_calls: [{ id: 'call_' + r, type: 'function', function: { name, arguments: args } }],
      });
      const body = isCode
        ? FILE_SNIPPETS[Math.floor(rng() * FILE_SNIPPETS.length)]
        : WEB_SNIPPETS[Math.floor(rng() * WEB_SNIPPETS.length)];
      msgs.push({ role: 'tool', content: body, tool_call_id: 'call_' + r });
    }
  }
  return msgs;
}

// ============================================================
// Pseudo-LLM: deterministic rule-based compressor
// ============================================================
function pseudoLight(_sp: string, input: string): string {
  // Input format: "Please compress the following N messages:" followed by
  // lines "[i] Role: content" separated by blank lines.
  const lines = input.split('\n\n');
  const items: { i: number; c: string }[] = [];
  for (const line of lines) {
    const m = line.match(/^(\d+)\]\s*(User|Assistant|tool|system):\s*([\s\S]*)$/);
    if (!m) continue;
    const i = parseInt(m[1], 10);
    const role = m[2];
    const content = m[3];
    let c: string;
    if (content.includes('FACT-')) {
      c = (FACT_RETENTION >= 1 || factRng() < FACT_RETENTION) ? content.slice(0, 200) : content.slice(0, 40) + '…';
    } else if (role === 'tool') {
      c = '[tool result] ' + content.slice(0, 60) + '…'; // tool payloads are big; distill hard
    } else {
      c = content.length > 80 ? content.slice(0, 80) + '…' : content;
    }
    items.push({ i, c });
  }
  return JSON.stringify(items);
}

function pseudoHeavy(_sp: string, input: string, heavyBudget: number): string {
  // Collect all facts present in the heavy zone input, bounded by heavyBudget.
  const facts: string[] = [];
  for (const m of input.matchAll(/FACT-\d+:[^\n,]*/g)) facts.push(m[0]);
  const unique = [...new Set(facts)];
  let budget = 0;
  const kept: string[] = [];
  for (let i = unique.length - 1; i >= 0; i--) { // keep NEWEST facts first under budget
    const f = unique[i];
    const cost = f.length;
    if (budget + cost > heavyBudget && kept.length > 0) break;
    if (budget + cost > heavyBudget) continue;
    kept.unshift(f);
    budget += cost;
  }
  const summary = kept.length > 0
    ? '[Summary] ' + kept.join('; ')
    : '[Summary] (early conversation faded)';
  return JSON.stringify([
    { role: 'user', content: summary },
    { role: 'assistant', content: '[Confirmed] Directions recorded; follow-ups tracked.' },
  ]);
}

function makePseudoLLM(heavyBudget: number): MosaicConfig['callLLM'] {
  return async (sp, input) => {
    if (sp.includes('exactly 2 messages')) return pseudoHeavy(sp, input, heavyBudget);
    return pseudoLight(sp, input);
  };
}

// ============================================================
// Analysis
// ============================================================
async function analyze(rounds: number, heavyBudget: number = DEFAULT_HEAVY_BUDGET): Promise<void> {
  FACTS.clear();
  factCounter = 0;
  const rng = mulberry32(rounds * 7919 + 13);
  const raw = makeConversation(rounds, rng);
  const rawTokens = totalTokens(raw);
  const rawFacts = [...FACTS.entries()];

  const config: MosaicConfig = {
    lightStart: 30, lightWindow: 10, heavyStart: 50, heavyWindow: 10,
    callLLM: makePseudoLLM(heavyBudget),
  };

  const out = await mosaicCompress(raw, config);
  const cTokens = totalTokens(out);
  const nMsgs = out.filter(m => m.role !== 'system').length;

  let kept = 0;
  const outText = out.map(m => m.content || '').join('\n');
  for (const [, factText] of rawFacts) {
    const tag = factText.split(':')[0];
    if (outText.includes(tag)) kept++;
  }

  const zoneStats = { raw: 0, light: 0, heavy: 0, lost: 0 };
  for (const [r, factText] of rawFacts) {
    const tag = factText.split(':')[0];
    const present = outText.includes(tag);
    if (!present) { zoneStats.lost++; continue; }
    if (r > rounds - 30) zoneStats.raw++;
    else if (r > rounds - 50) zoneStats.light++;
    else zoneStats.heavy++;
  }

  console.log('  Rounds: ' + rounds + '  |  msgs: ' + (raw.length - 1) + ' → ' + nMsgs +
    '  |  tokens: ' + rawTokens.toLocaleString() + ' → ' + cTokens.toLocaleString() +
    '  |  ratio: ' + (100 * (1 - cTokens / rawTokens)).toFixed(1) + '%');
  console.log('    facts planted: ' + rawFacts.length + '  kept: ' + kept +
    ' (' + (100 * kept / Math.max(1, rawFacts.length)).toFixed(1) + '%)' +
    '  zone: raw=' + zoneStats.raw + ' light=' + zoneStats.light + ' heavy=' + zoneStats.heavy + ' lost=' + zoneStats.lost);
  const byRole: Record<string, number> = {};
  for (const m of out) {
    const k = m.role;
    byRole[k] = (byRole[k] || 0) + estTokens(m);
  }
  console.log('    compressed token breakdown: ' + Object.entries(byRole).map(([k, v]) => k + '=' + Math.round(v)).join('  '));
}

// Compact variant for the budget sweep: returns numbers for tabular output.
async function analyzeCompact(rounds: number, heavyBudget: number) {
  FACTS.clear();
  factCounter = 0;
  const rng = mulberry32(rounds * 7919 + 13);
  const raw = makeConversation(rounds, rng);
  const rawTokens = totalTokens(raw);
  const rawFacts = [...FACTS.entries()];
  const config: MosaicConfig = {
    lightStart: 30, lightWindow: 10, heavyStart: 50, heavyWindow: 10,
    callLLM: makePseudoLLM(heavyBudget),
  };
  const out = await mosaicCompress(raw, config);
  const cTokens = totalTokens(out);
  const outText = out.map(m => m.content || '').join('\n');
  let kept = 0;
  for (const [, factText] of rawFacts) {
    const tag = factText.split(':')[0];
    if (outText.includes(tag)) kept++;
  }
  return {
    msgs: out.filter(m => m.role !== 'system').length,
    tokens: cTokens,
    ratio: 100 * (1 - cTokens / rawTokens),
    kept,
    total: rawFacts.length,
    keptPct: 100 * kept / Math.max(1, rawFacts.length),
  };
}

// ============================================================
// User-file mode: analyze a provided conversation file
// ============================================================
async function analyzeFile(path: string): Promise<void> {
  let raw: Message[];
  try {
    const parsed = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('top-level JSON must be an array of Message objects');
    raw = parsed;
    for (const m of raw) {
      if (!m || typeof m.role !== 'string' || typeof m.content !== 'string') {
        throw new Error('each entry must be { role: string, content: string }');
      }
    }
  } catch (err) {
    console.error('[bench] cannot read ' + path + ': ' + (err as Error).message);
    console.error('Expected format: JSON array of { "role": "user|assistant|system|tool", "content": "...", ... }');
    process.exit(1);
  }

  const rawTokens = totalTokens(raw);
  const config: MosaicConfig = {
    lightStart: 30, lightWindow: 10, heavyStart: 50, heavyWindow: 10,
    callLLM: makePseudoLLM(DEFAULT_HEAVY_BUDGET),
  };

  console.log('File: ' + path);
  console.log('  messages: ' + raw.length + '  |  est. tokens: ' + rawTokens.toLocaleString());
  console.log('  role mix: ' + Object.entries(raw.reduce<Record<string, number>>((acc, m) => { acc[m.role] = (acc[m.role] || 0) + 1; return acc; }, {}))
    .map(([k, v]) => k + '=' + v).join('  '));

  const out = await mosaicCompress(raw, config);
  const cTokens = totalTokens(out);
  const nMsgs = out.filter(m => m.role !== 'system').length;
  console.log('  after compression: msgs ' + raw.length + ' → ' + out.length +
    '  |  est. tokens ' + rawTokens.toLocaleString() + ' → ' + cTokens.toLocaleString() +
    '  |  ratio: ' + (100 * (1 - cTokens / rawTokens)).toFixed(1) + '%');
  console.log('  (deterministic pseudo-LLM; hook your own callLLM for real-model results)');
}

// ============================================================
// Main
// ============================================================
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf('--file');
  if (fileIdx >= 0) {
    const path = args[fileIdx + 1];
    if (!path) { console.error('usage: npm run bench -- --file <chat.json>'); process.exit(1); }
    await analyzeFile(path);
    return;
  }

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  MosaicCompress — Deterministic Mechanism Simulation    ║');
  console.log('║  (real algorithm, rule-based pseudo-LLM, zero LLM cost) ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('Parameters: toolRoundRate=' + TOOL_ROUND_RATE + ' reasoningRate=' + REASONING_RATE +
    ' factEvery=' + FACT_EVERY + ' factRetention=' + FACT_RETENTION + ' defaultHeavyBudget=' + DEFAULT_HEAVY_BUDGET);
  console.log('');
  // ── Budget sensitivity: retention vs steady-state size tradeoff ──
  console.log('');
  console.log('── Budget sensitivity (heavy summary max tokens) ──');
  console.log('  budget    rounds   msgs out   tokens out   ratio    facts kept');
  for (const budget of BUDGET_SWEEP) {
    for (const rounds of [1000, 5000]) {
      const r = await analyzeCompact(rounds, budget);
      console.log('  ' + String(budget).padStart(8) + '  ' + String(rounds).padStart(6) +
        '   ' + String(r.msgs).padStart(8) + '   ' + String(r.tokens).padStart(10) +
        '   ' + r.ratio.toFixed(1).padStart(5) + '%   ' + r.kept + '/' + r.total +
        ' (' + r.keptPct.toFixed(1) + '%)');
    }
  }

  // ── Standard sweep with the default budget ──
  console.log('');
  console.log('Sweep (default heavy budget ' + DEFAULT_HEAVY_BUDGET + '):');
  for (const rounds of [100, 500, 1000, 5000, 20000]) {
    await analyze(rounds);
  }
  console.log('');
  console.log('Done. (mechanism-level results; real-LLM spot check calibrates later)');
  console.log('Tip: analyze your own conversation file with: npm run bench -- --file chat.json');
}

main().catch(err => { console.error(err); process.exit(1); });