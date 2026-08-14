/**
 * MosaicCompress Unit Tests (Zero LLM Cost)
 *
 * Tests the stateless compression logic using mock LLM responses.
 * Run: npx tsx tests/index.test.ts
 *
 * License: MIT
 */

import { mosaicCompress, DEFAULT_CONFIG, type MosaicConfig, type Message } from '../src/index';

// ============================================================
// Test harness
// ============================================================

let PASS = 0;
let FAIL = 0;

function check(desc: string, condition: boolean): void {
  if (condition) { console.log(`  ✅ PASS: ${desc}`); PASS++; }
  else { console.log(`  ❌ FAIL: ${desc}`); FAIL++; }
}

function checkEq<T>(desc: string, actual: T, expected: T): void {
  if (actual === expected) { console.log(`  ✅ PASS: ${desc}`); PASS++; }
  else {
    console.log(`  ❌ FAIL: ${desc}`);
    console.log(`     expected: ${JSON.stringify(expected)}`);
    console.log(`     got:      ${JSON.stringify(actual)}`);
    FAIL++;
  }
}

function section(title: string): void { console.log(`\n━━━ ${title} ━━━`); }

// ============================================================
// Message builders
// ============================================================

function sys(c: string): Message { return { role: 'system', content: c }; }
function usr(c: string): Message { return { role: 'user', content: c }; }
function ast(c: string): Message { return { role: 'assistant', content: c }; }
function tool(c: string): Message { return { role: 'tool', content: c, tool_call_id: 't1' }; }

function astWithTool(name: string): Message {
  return { role: 'assistant', content: 'Let me check...', tool_calls: [{ id: 'x', type: 'function', function: { name, arguments: '{}' } }] };
}

function makeConv(rounds: number, withSys = true): Message[] {
  const msgs: Message[] = [];
  if (withSys) msgs.push(sys('You are Story Elf, a creative writing companion.'));
  for (let i = 1; i <= rounds; i++) {
    msgs.push(usr(`Round ${i} user: Discussing worldbuilding and character arcs. Prefers fast-paced narrative.`));
    msgs.push(ast(`Round ${i} assistant: Confirmed soft magic system. Suggested fall-arc protagonist.`));
  }
  return msgs;
}

function countMsgs(msgs: Message[]): number {
  return msgs.filter(m => m.role !== 'system').length;
}

// ============================================================
// Mock LLM callbacks
// ============================================================

function mockLight(): MosaicConfig['callLLM'] {
  return async (_sp: string, input: string) => {
    const match = input.match(/compress the following (\d+) messages/);
    const n = match ? parseInt(match[1]) : 20;
    const items: { i: number; c: string }[] = [];
    for (let i = 0; i < n; i++) {
      const isUser = i % 2 === 0;
      items.push({ i, c: isUser ? '[compressed] User discussed creative topics' : '[compressed] Assistant gave suggestions' });
    }
    return JSON.stringify(items);
  };
}

function mockLightBad(): MosaicConfig['callLLM'] {
  return async () => 'This is not valid JSON at all.';
}

function mockLightThrow(): MosaicConfig['callLLM'] {
  return async () => { throw new Error('Simulated LLM failure'); };
}

function mockHeavy(): MosaicConfig['callLLM'] {
  return async () => JSON.stringify([
    { role: 'user', content: '[Summary] Discussed worldbuilding and character arcs. Decided on soft magic and fall-arc protagonist.' },
    { role: 'assistant', content: '[Confirmed] Directions recorded.' },
  ]);
}

function mockBoth(): MosaicConfig['callLLM'] {
  const light = mockLight();
  const heavy = mockHeavy();
  return async (sp, inp) => {
    return inp.includes('compress the following') ? light(sp, inp) : heavy(sp, inp);
  };
}

// ============================================================
// Test cases
// ============================================================

async function run(): Promise<void> {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   MosaicCompress Unit Tests (Zero LLM)  ║');
  console.log('╚══════════════════════════════════════════╝');

  const baseCfg = { ...DEFAULT_CONFIG, callLLM: mockLight() };

  // ── 1 ──
  section('1. Below threshold (R=20 < lightStart=30) → immediate return');
  {
    const msgs = makeConv(20);
    const res = await mosaicCompress(msgs, baseCfg);
    checkEq('Array unchanged', res.length, msgs.length);
    check('Content identical', JSON.stringify(res) === JSON.stringify(msgs));
  }

  // ── 2 ──
  section('2. Non-window round (R=33, 33%10≠0) → no compression');
  {
    const msgs = makeConv(33);
    const res = await mosaicCompress(msgs, baseCfg);
    checkEq('Array unchanged', res.length, msgs.length);
  }

  // ── 3 ──
  section('3. Light Compress (R=40, 40%10==0)');
  {
    const msgs = makeConv(40);
    const cfg = { ...baseCfg, callLLM: mockLight() };
    const res = await mosaicCompress(msgs, cfg);
    checkEq('System prompt preserved', res[0].content, msgs[0].content);
    // R=40: heavyEnd=-10→0, lightEnd=10. Light zone = rounds 1-10.
    checkEq('Count unchanged (Light preserves message count)', countMsgs(res), 80);
    check('Light zone message distilled', res[1].content!.includes('[compressed]'));
  }

  // ── 4 ──
  section('4. R=50: Light triggers, Heavy zone empty (heavyEnd=0)');
  {
    const msgs = makeConv(50);
    const cfg = { ...baseCfg, callLLM: mockBoth() };
    const res = await mosaicCompress(msgs, cfg);
    checkEq('System prompt preserved', res[0].content, msgs[0].content);
    checkEq('Heavy zone empty, count unchanged', countMsgs(res), 100);
  }

  // ── 5 ──
  section('5. R=60: Heavy (10 rounds → 2 msgs) + Light (20 rounds distilled)');
  {
    const msgs = makeConv(60);
    const cfg = { ...baseCfg, callLLM: mockBoth() };
    const res = await mosaicCompress(msgs, cfg);
    checkEq('System prompt preserved', res[0].content, msgs[0].content);
    // R=60: heavyEnd=10, lightEnd=30 → 2+40+60=102 history msgs
    checkEq('Message count: 2(H) + 40(L) + 60(R) = 102', countMsgs(res), 102);
    check('Heavy summary present', res[1].content!.includes('Summary'));
    check('Heavy confirmation present', res[2].content!.includes('Confirmed'));
  }

  // ── 6 ──
  section('6. Steady state — message count constant regardless of R');
  {
    const cfg = { ...baseCfg, callLLM: mockBoth() };
    const r100 = await mosaicCompress(makeConv(100), cfg);
    const r200 = await mosaicCompress(makeConv(200), cfg);
    checkEq('R=100 count = 102', countMsgs(r100), 102);
    checkEq('R=200 count = 102', countMsgs(r200), 102);
    checkEq('R=100 equals R=200', countMsgs(r100), countMsgs(r200));
  }

  // ── 7 ──
  section('7. System prompt never modified');
  {
    const longSys = 'Long system prompt. '.repeat(100);
    const msgs: Message[] = [sys(longSys), ...Array.from({ length: 80 }, (_, i) =>
      i % 2 === 0 ? usr(`Msg ${i}`) : ast(`Reply ${i}`)
    )];
    const res = await mosaicCompress(msgs, baseCfg);
    checkEq('Content unchanged', res[0].content, longSys);
    checkEq('Length unchanged', res[0].content!.length, longSys.length);
  }

  // ── 8 ──
  section('8. Pure conversation (no system prompt)');
  {
    const msgs = makeConv(40, false);
    const res = await mosaicCompress(msgs, baseCfg);
    check('No system role', res[0].role !== 'system');
    checkEq('Count unchanged', res.length, msgs.length);
  }

  // ── 9 ──
  section('9. Tool calls do not affect round counting');
  {
    const msgs: Message[] = [
      sys('S'), usr('Check worldbuilding'),
      astWithTool('read_module'), tool('{"m1":"..."}'),
      ast('Suggest soft magic.'), usr('Continue characters'), ast('Fall-arc protagonist.'),
    ];
    const res = await mosaicCompress(msgs, baseCfg);
    checkEq('Below threshold, array unchanged', res.length, msgs.length);
    checkEq('Tool messages preserved', res.filter(m => m.role === 'tool').length, 1);
  }

  // ── 10 ──
  section('10. Malformed JSON → fallback, no crash');
  {
    const msgs = makeConv(40);
    const cfg = { ...baseCfg, callLLM: mockLightBad() };
    const res = await mosaicCompress(msgs, cfg);
    checkEq('Count unchanged (fallback)', res.length, msgs.length);
  }

  // ── 11 ──
  section('11. LLM throws → graceful degradation');
  {
    const msgs = makeConv(40);
    const cfg = { ...baseCfg, callLLM: mockLightThrow() };
    const res = await mosaicCompress(msgs, cfg);
    checkEq('Count unchanged (error fallback)', res.length, msgs.length);
  }

  // ── 12 ──
  section('12. Custom parameters');
  {
    const cfg: MosaicConfig = { lightStart: 10, lightWindow: 5, heavyStart: 20, heavyWindow: 5, callLLM: mockLight() };
    const msgs = makeConv(15, false);
    const res = await mosaicCompress(msgs, cfg);
    checkEq('Count unchanged', res.length, msgs.length);
  }

  // ── 13 ──
  section('13. Heavy anti-jitter: R=50, heavyWindow=7 → no Heavy');
  {
    const cfg: MosaicConfig = { ...DEFAULT_CONFIG, heavyWindow: 7, callLLM: mockLight() };
    const res = await mosaicCompress(makeConv(50), cfg);
    checkEq('Only Light triggered', countMsgs(res), 100);
  }

  // ── 14 ──
  section('14. Light Compress preserves role sequence');
  {
    const msgs = makeConv(40);
    const res = await mosaicCompress(msgs, baseCfg);
    checkEq('Roles identical', JSON.stringify(res.map(m => m.role)), JSON.stringify(msgs.map(m => m.role)));
  }

  // ── 15 ──
  section('15. Bulk call: R=200 single invocation');
  {
    const cfg = { ...baseCfg, callLLM: mockBoth() };
    const res = await mosaicCompress(makeConv(200), cfg);
    checkEq('Count: 2+40+60=102', countMsgs(res), 102);
    check('Heavy summary present', res[1].content!.includes('Summary'));
  }

  // ── 16 ──
  section('16. Light compress: LLM misses an entry → original preserved verbatim (no truncation)');
  {
    const msgs = makeConv(40);
    // The mock only returns entries for even indexes; index 1 (assistant of
    // round 1) is missing. Make it long so truncation would be visible.
    msgs[2].content = 'LONG CONTENT '.repeat(50) + 'TAIL-MARKER';
    const cfg = { ...baseCfg, callLLM: async () => {
      const items: { i: number; c: string }[] = [];
      for (let i = 0; i < 40; i += 2) items.push({ i, c: '[compressed]' });
      return JSON.stringify(items);
    }};
    const res = await mosaicCompress(msgs, cfg);
    checkEq('Count unchanged', res.length, msgs.length);
    check('Compressed entries still applied', res[1].content!.includes('[compressed]'));
    check('Missing entry keeps full original content', res[2].content === msgs[2].content);
  }

  // ── 17 ──
  section('17. LLM returns Markdown-fenced JSON → parsed correctly');
  {
    const msgs = makeConv(40);
    const cfg = { ...baseCfg, callLLM: async (_sp: string, input: string) => {
      const match = input.match(/compress the following (\d+) messages/);
      const n = match ? parseInt(match[1]) : 20;
      const items: { i: number; c: string }[] = [];
      for (let i = 0; i < n; i++) items.push({ i, c: '[compressed]' });
      return 'Here is the result:\n\`\`\`json\n' + JSON.stringify(items) + '\n\`\`\`';
    }};
    const res = await mosaicCompress(msgs, cfg);
    check('Fenced JSON parsed and applied', res[1].content!.includes('[compressed]'));
  }

  // ── 18 ──
  section('18. Invalid configs throw TypeError');
  {
    const msgs = makeConv(10);
    let threw = false;
    try { await mosaicCompress(msgs, { ...baseCfg, lightWindow: 0 }); } catch (err) { threw = (err as Error).name === 'TypeError'; }
    check('lightWindow=0 throws TypeError', threw);

    threw = false;
    try { await mosaicCompress(msgs, { ...baseCfg, lightStart: 30, heavyStart: 20 }); } catch (err) { threw = (err as Error).name === 'TypeError'; }
    check('heavyStart <= lightStart throws TypeError', threw);

    threw = false;
    try { await mosaicCompress(msgs, { ...baseCfg, lightStart: -5 }); } catch (err) { threw = (err as Error).name === 'TypeError'; }
    check('negative lightStart throws TypeError', threw);
  }

  // ── Summary ──
  console.log(`\n══════════════════════════════════════════`);
  console.log(`  Total: ${PASS + FAIL}  |  ✅ PASS: ${PASS}  |  ❌ FAIL: ${FAIL}`);
  console.log(`══════════════════════════════════════════`);
  if (FAIL > 0) (globalThis as any).process?.exit?.(1);
}

run().catch(err => { console.error(err); (globalThis as any).process?.exit?.(1); });
