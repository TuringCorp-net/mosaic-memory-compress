// M3 layer-3: real-LLM spot check.
// Runs the REAL mosaicCompress with the REAL DeepSeek V4 Flash as callLLM,
// on a 100-round synthetic conversation with 20 planted facts.
import { mosaicCompress, type MosaicConfig, type Message } from '../src/index.ts';
import { readFileSync } from 'node:fs';

// ---- DeepSeek API client (key read from DSH credentials, never printed) ----
function apiKey(): string {
  // 1) explicit env var (recommended for non-DSH users)
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  // 2) fall back to a DSH-style credentials file
  const cred = readFileSync('/home/uncleli/.dsh/.credentials.yaml', 'utf8');
  const m = cred.match(/DEEPSEEK_API_KEY:\s*(\S+)/);
  if (!m) throw new Error('set DEEPSEEK_API_KEY or provide a DSH credentials file');
  return m[1];
}
const KEY = apiKey();
const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';
let totalPrompt = 0, totalCompletion = 0;
async function callDeepSeek(systemPrompt: string, userInput: string): Promise<string> {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userInput },
      ],
      max_tokens: 8192,
      temperature: 0.3,
    }),
    signal: AbortSignal.timeout(240000),
  });
  if (!res.ok) throw new Error('API ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const j = await res.json();
  totalPrompt += j.usage?.prompt_tokens ?? 0;
  totalCompletion += j.usage?.completion_tokens ?? 0;
  const text = j.choices?.[0]?.message?.content ?? '';
  if (!text) throw new Error('empty completion');
  return text;
}

// ---- conversation generator (same as the simulator) ----
const TOOL_ROUND_RATE = 0.15, REASONING_RATE = 0.3, FACT_EVERY = 20;
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const FACTS: Map<number, string> = new Map();
let factCounter = 0;
function plantFact(round: number, content: string): string { factCounter++; const tag = 'FACT-' + factCounter; FACTS.set(round, tag + ': ' + content); return tag + ': ' + content; }
const FILE_SNIPPETS = [
  'export async function handleRequest(req: Request): Promise<Response> {\n  const url = new URL(req.url);\n  const params = url.searchParams;\n  const query = params.get("q") || "";\n  const results = await searchIndex.lookup(query, { limit: 20, fuzzy: true });\n  return Response.json({ ok: true, count: results.length, items: results });\n}',
  'class VectorStore {\n  private vectors: Float32Array[] = [];\n  private meta: Record<number, { id: string; source: string }> = {};\n  async add(id: string, vector: Float32Array, source: string) {\n    this.vectors.push(vector);\n    this.meta[this.vectors.length - 1] = { id, source };\n  }\n}',
];
const WEB_SNIPPETS = [
  'According to the docs, the API returns a paginated response: { "data": [...], "next_cursor": "abc123" }. Rate limits are 60 req/min for free tier.',
  'The benchmark results show qwen2.5-72b achieving 78.3% on the long-context retrieval task, while the 7b variant drops to 52.1%.',
];
const USER_FILLERS = ['嗯，我大概明白了，你继续说。', '这个思路可以，那我们再看看下一步。', '好的，我同意，先这样定。', '有道理，不过我想再确认一个细节。', '行，就按这个方向推进。'];
const ASSISTANT_REPLIES = [
  '好的，我整理一下：核心思路是保持接口不变，内部实现分三层，每层职责单一，边界用类型收口。你看这个划分是否合理？',
  '确认收到。我的建议是先落地最小可用版本，把链路打通，然后再逐步优化性能，避免过早抽象。',
  '这里我补充一个考虑：异步场景下要注意竞态问题，建议用单一数据源加版本号校验。',
  '明白了，那么下一步我会：1) 梳理现有接口签名；2) 补充边界测试；3) 跑一遍回归。',
  '这个方案技术上可行，成本上也能接受。唯一要留意的是冷启动延迟。',
];
function makeConversation(rounds: number, rng: () => number): Message[] {
  const msgs: Message[] = [{ role: 'system', content: 'You are MosaicBench, a helpful engineering assistant.' }];
  for (let r = 1; r <= rounds; r++) {
    let userText = USER_FILLERS[Math.floor(rng() * USER_FILLERS.length)];
    if (r % FACT_EVERY === 0) {
      const topics = ['用户决定数据库选用 PostgreSQL，迁移时间为下周一', '用户偏好 TypeScript strict 模式，拒绝 any', '用户确认定价方案为按量计费，月封顶 50 美元', '用户要求日志保留 90 天，敏感字段脱敏', '用户选定 UI 采用深色主题，字体使用 Inter'];
      userText += ' 对了，' + plantFact(r, topics[Math.floor(rng() * topics.length)]);
    }
    msgs.push({ role: 'user', content: userText });
    const reply: Message = { role: 'assistant', content: ASSISTANT_REPLIES[Math.floor(rng() * ASSISTANT_REPLIES.length)] };
    if (rng() < REASONING_RATE) reply.reasoning_content = '思考：用户提到的核心约束是' + (r % FACT_EVERY === 0 ? '新确定的事实' : '既有上下文') + '，需要确认并给出建议。';
    msgs.push(reply);
    if (rng() < TOOL_ROUND_RATE) {
      const isCode = rng() < 0.5;
      const name = isCode ? 'read_file' : 'search_web';
      const args = JSON.stringify(isCode ? { path: 'src/core/store.ts' } : { query: 'long-context benchmark' });
      msgs.push({ role: 'assistant', content: isCode ? '我先读一下相关源码再回答。' : '我查一下相关文档。', tool_calls: [{ id: 'call_' + r, type: 'function', function: { name, arguments: args } }] });
      msgs.push({ role: 'tool', content: isCode ? FILE_SNIPPETS[0] : WEB_SNIPPETS[0], tool_call_id: 'call_' + r });
    }
  }
  return msgs;
}
function estTokens(m: Message): number {
  let t = 0;
  for (const ch of m.content || '') t += ch.charCodeAt(0) > 127 ? 1 : 0.25;
  if (m.reasoning_content) for (const ch of m.reasoning_content) t += ch.charCodeAt(0) > 127 ? 1 : 0.25;
  if (m.tool_calls) t += JSON.stringify(m.tool_calls).length * 0.3;
  return Math.max(1, Math.round(t));
}
function totalTokens(msgs: Message[]): number { return msgs.reduce((s, m) => s + estTokens(m), 0); }

// ---- run ----
async function main(): Promise<void> {
  const rng = mulberry32(424242);
  const raw = makeConversation(100, rng);
  const rawFacts = [...FACTS.entries()];
  const rawTok = totalTokens(raw);

  const config: MosaicConfig = {
    lightStart: 30, lightWindow: 10, heavyStart: 50, heavyWindow: 10,
    callLLM: callDeepSeek,
  };

  console.log('原始对话: rounds=100 msgs=' + raw.length + ' estTokens=' + rawTok.toLocaleString() + ' facts=' + rawFacts.length);
  const t0 = Date.now();
  const out = await mosaicCompress(raw, config);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const outTok = totalTokens(out);

  console.log('压缩后: msgs=' + raw.length + ' -> ' + out.length + ' estTokens=' + rawTok.toLocaleString() + ' -> ' + outTok.toLocaleString() +
    ' ratio=' + (100 * (1 - outTok / rawTok)).toFixed(1) + '%  (real LLM, ' + elapsed + 's)');
  console.log('API usage: prompt=' + totalPrompt.toLocaleString() + ' completion=' + totalCompletion.toLocaleString() + ' tokens');

  // fact retention by tag
  const outText = out.map(m => m.content || '').join('\n');
  let kept = 0;
  const keptList: string[] = [], lostList: string[] = [];
  for (const [r2, factText] of rawFacts) {
    const tag = factText.split(':')[0];
    if (outText.includes(tag)) { kept++; keptList.push(tag); }
    else lostList.push(tag + ' (round ' + r2 + ')');
  }
  console.log('事实保持: ' + kept + '/' + rawFacts.length + ' (' + (100 * kept / rawFacts.length).toFixed(0) + '%)');
  console.log('丢失: ' + (lostList.length ? lostList.join(' | ') : '无'));

  // structure
  const toolIds = out.filter(m => m.role === 'tool').map(m => m.tool_call_id);
  const callIds = out.flatMap(m => m.tool_calls || []).map(t => t.id);
  console.log('工具配对完整: ' + toolIds.every(id => callIds.includes(id!)) + ' (tools=' + toolIds.length + ' calls=' + callIds.length + ')');

  // dump the compressed heavy summary + first light-distilled messages for review
  console.log('\n=== HEAVY 摘要（前 2 条消息）===');
  for (const m of out.slice(0, 2)) console.log('[' + m.role + '] ' + (m.content || '').slice(0, 1200));
  console.log('\n=== LIGHT 区样例（3 条）===');
  const lightStart = 2;
  for (const m of out.slice(lightStart, lightStart + 3)) console.log('[' + m.role + '] ' + (m.content || '').slice(0, 200));
  console.log('\n=== RAW 区最后一条 ===');
  console.log('[' + out[out.length - 1].role + '] ' + (out[out.length - 1].content || '').slice(0, 150));
}
main().catch(err => { console.error('FAILED:', err); process.exit(1); });