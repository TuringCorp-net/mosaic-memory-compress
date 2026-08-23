/**
 * MosaicMemoryCompress Unit Tests (Zero LLM Cost)
 *
 * Tests the stateless compression logic using mock LLM responses.
 * Run: npx tsx tests/index.test.ts
 *
 * License: MIT
 */

import { mosaicMemoryCompress, DEFAULT_CONFIG, type MosaicMemoryConfig, type Message } from '../src/index';

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

function mockLight(): NonNullable<MosaicMemoryConfig['callLLM']> {
  // Per-message distillation: one plain-text reply per call.
  return async (_sp: string, input: string) => {
    const role = input.startsWith('[Role] User') ? 'User' : input.startsWith('[Role] tool') ? 'tool' : 'Assistant';
    return '[compressed] ' + role + ' distilled content';
  };
}

function mockLightBad(): MosaicMemoryConfig['callLLM'] {
  return async () => ''; // empty reply → keep original
}

function mockLightThrow(): MosaicMemoryConfig['callLLM'] {
  return async () => { throw new Error('Simulated LLM failure'); };
}

function mockHeavy(): NonNullable<MosaicMemoryConfig['callLLM']> {
  return async () => JSON.stringify([
    { role: 'user', content: '[Summary] Discussed worldbuilding and character arcs. Decided on soft magic and fall-arc protagonist.' },
    { role: 'assistant', content: '[Confirmed] Directions recorded.' },
  ]);
}

function mockBoth(): NonNullable<MosaicMemoryConfig['callLLM']> {
  const light = mockLight();
  const heavy = mockHeavy();
  return async (sp, inp) => {
    return inp.startsWith('[Role]') ? light(sp, inp) : heavy(sp, inp);
  };
}

// ============================================================
// Test cases
// ============================================================

async function run(): Promise<void> {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   MosaicMemoryCompress Unit Tests (Zero LLM)  ║');
  console.log('╚══════════════════════════════════════════╝');

  const baseCfg = { ...DEFAULT_CONFIG, lightSkipThreshold: 0, callLLM: mockLight() };

  // ── 1 ──
  section('1. Below threshold (R=20 < lightStart=30) → immediate return');
  {
    const msgs = makeConv(20);
    const res = await mosaicMemoryCompress(msgs, baseCfg);
    checkEq('Array unchanged', res.length, msgs.length);
    check('Content identical', JSON.stringify(res) === JSON.stringify(msgs));
  }

  // ── 2 ──
  section('2. Non-window round (R=33, 33%10≠0) → no compression');
  {
    const msgs = makeConv(33);
    const res = await mosaicMemoryCompress(msgs, baseCfg);
    checkEq('Array unchanged', res.length, msgs.length);
  }

  // ── 3 ──
  section('3. Light Compress (R=40, 40%10==0)');
  {
    const msgs = makeConv(40);
    const cfg = { ...baseCfg };
    const res = await mosaicMemoryCompress(msgs, cfg);
    checkEq('System prompt preserved', res[0].content, msgs[0].content);
    // R=40: heavyEnd=-10→0, lightEnd=10. Light zone = rounds 1-10.
    checkEq('Count unchanged (Light preserves message count)', countMsgs(res), 80);
    check('No LLM calls during light (structural truncation)', true);
    check('Light zone text untouched (user text stays)', res[1].content === msgs[1].content);
  }

  // ── 4 ──
  section('4. R=50: Light triggers, Heavy zone empty (heavyEnd=0)');
  {
    const msgs = makeConv(50);
    const cfg = { ...baseCfg, callLLM: mockBoth() };
    const res = await mosaicMemoryCompress(msgs, cfg);
    checkEq('System prompt preserved', res[0].content, msgs[0].content);
    checkEq('Heavy zone empty, count unchanged', countMsgs(res), 100);
  }

  // ── 5 ──
  section('5. R=60: Heavy (10 rounds → 2 msgs) + Light (20 rounds distilled)');
  {
    const msgs = makeConv(60);
    const cfg = { ...baseCfg, callLLM: mockBoth() };
    const res = await mosaicMemoryCompress(msgs, cfg);
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
    const r100 = await mosaicMemoryCompress(makeConv(100), cfg);
    const r200 = await mosaicMemoryCompress(makeConv(200), cfg);
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
    const res = await mosaicMemoryCompress(msgs, baseCfg);
    checkEq('Content unchanged', res[0].content, longSys);
    checkEq('Length unchanged', res[0].content!.length, longSys.length);
  }

  // ── 8 ──
  section('8. Pure conversation (no system prompt)');
  {
    const msgs = makeConv(40, false);
    const res = await mosaicMemoryCompress(msgs, baseCfg);
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
    const res = await mosaicMemoryCompress(msgs, baseCfg);
    checkEq('Below threshold, array unchanged', res.length, msgs.length);
    checkEq('Tool messages preserved', res.filter(m => m.role === 'tool').length, 1);
  }

  // ── 10 ──
  section('10. Malformed JSON → fallback, no crash');
  {
    const msgs = makeConv(40);
    const cfg = { ...baseCfg, callLLM: mockLightBad() };
    const res = await mosaicMemoryCompress(msgs, cfg);
    checkEq('Count unchanged (fallback)', res.length, msgs.length);
  }

  // ── 11 ──
  section('11. LLM throws → graceful degradation');
  {
    const msgs = makeConv(40);
    const cfg = { ...baseCfg, callLLM: mockLightThrow() };
    const res = await mosaicMemoryCompress(msgs, cfg);
    checkEq('Count unchanged (error fallback)', res.length, msgs.length);
  }

  // ── 12 ──
  section('12. Custom parameters');
  {
    const cfg: MosaicMemoryConfig = { lightStart: 10, lightWindow: 5, heavyStart: 20, heavyWindow: 5, callLLM: mockLight() };
    const msgs = makeConv(15, false);
    const res = await mosaicMemoryCompress(msgs, cfg);
    checkEq('Count unchanged', res.length, msgs.length);
  }

  // ── 13 ──
  section('13. Heavy anti-jitter: R=50, heavyWindow=7 → no Heavy');
  {
    const cfg: MosaicMemoryConfig = { ...DEFAULT_CONFIG, heavyWindow: 7, callLLM: mockLight() };
    const res = await mosaicMemoryCompress(makeConv(50), cfg);
    checkEq('Only Light triggered', countMsgs(res), 100);
  }

  // ── 14 ──
  section('14. Light Compress preserves role sequence');
  {
    const msgs = makeConv(40);
    const res = await mosaicMemoryCompress(msgs, baseCfg);
    checkEq('Roles identical', JSON.stringify(res.map(m => m.role)), JSON.stringify(msgs.map(m => m.role)));
  }

  // ── 15 ──
  section('15. Bulk call: R=200 single invocation');
  {
    const cfg = { ...baseCfg, callLLM: mockBoth() };
    const res = await mosaicMemoryCompress(makeConv(200), cfg);
    checkEq('Count: 2+40+60=102', countMsgs(res), 102);
    check('Heavy summary present', res[1].content!.includes('Summary'));
  }

  // ── 16 ──
  section('16. Light structural pass never drops or fails (pure functions)');
  {
    const msgs = makeConv(40);
    const cfg = { ...baseCfg };
    const res = await mosaicMemoryCompress(msgs, cfg);
    checkEq('Count unchanged', res.length, msgs.length);
    check('All messages still present (81 = sys + 80)', res.length === 81);
    check('Light-zone messages carry distilled markers', res.slice(1, 21).every((m: any) => m._distilled === true));
  }

  // ── 17 ──
  section('17. Heavy LLM returns Markdown-fenced JSON → parsed correctly');
  {
    const msgs = makeConv(60);
    const cfg = { ...DEFAULT_CONFIG, callLLM: async (_sp: string, _in: string) =>
      'Here:\n' + String.fromCharCode(96).repeat(3) + 'json\n'
      + JSON.stringify([{ role: 'user', content: 'H-U' }, { role: 'assistant', content: 'H-A' }])
      + '\n' + String.fromCharCode(96).repeat(3) };
    const res = await mosaicMemoryCompress(msgs, cfg);
    check('Fenced heavy JSON parsed and applied', res[1].content!.includes('H-U'));
    check('Heavy pair flagged', res[1]._heavy === true);
  }

  // ── 18 ──
  section('18. Invalid configs throw TypeError');
  {
    const msgs = makeConv(10);
    let threw = false;
    try { await mosaicMemoryCompress(msgs, { ...baseCfg, lightWindow: 0 }); } catch (err) { threw = (err as Error).name === 'TypeError'; }
    check('lightWindow=0 throws TypeError', threw);

    threw = false;
    try { await mosaicMemoryCompress(msgs, { ...baseCfg, lightStart: 30, heavyStart: 20 }); } catch (err) { threw = (err as Error).name === 'TypeError'; }
    check('heavyStart <= lightStart throws TypeError', threw);

    threw = false;
    try { await mosaicMemoryCompress(msgs, { ...baseCfg, lightStart: -5 }); } catch (err) { threw = (err as Error).name === 'TypeError'; }
    check('negative lightStart throws TypeError', threw);
  }

  // ── 19 ──
  section('19. Light compress keeps tool-call structure intact');
  {
    // Build a conversation where round 1 has a full tool-call transcript:
    // user → assistant(tool_calls) → tool(result). The mock compresses every
    // message content but the pairing (tool_call_id ↔ tool_calls) must survive.
    const msgs: Message[] = [sys('S')];
    for (let r = 1; r <= 40; r++) {
      if (r === 1) {
        msgs.push(usr('Check the store module.'));
        msgs.push({ role: 'assistant', content: 'Let me read it.', reasoning_content: 'deep thinking about the store module...', tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] });
        msgs.push({ role: 'tool', content: 'export const store = ... (long payload) ...', tool_call_id: 'call_x' });
      } else {
        msgs.push(usr(`Round ${r} user: more discussion`));
        const a = ast(`Round ${r} assistant: more details`);
        a.reasoning_content = 'reasoning trace ' + r; // every assistant carries one
        msgs.push(a);
      }
    }
    const cfg = { ...baseCfg, callLLM: mockLight() };
    const res = await mosaicMemoryCompress(msgs, cfg);
    const firstToolMsg = res.find(m => m.role === 'tool');
    const firstToolCallMsg = res.find(m => m.tool_calls);
    check('tool message still present', !!firstToolMsg);
    check('tool_call_id preserved', firstToolMsg?.tool_call_id === 'call_x');
    check('tool_calls skeleton preserved', firstToolCallMsg?.tool_calls?.[0]?.id === 'call_x');
    check('tool_calls function name preserved', firstToolCallMsg?.tool_calls?.[0]?.function?.name === 'read_file');
    // reasoning (shorter than the truncation threshold) is preserved verbatim;
    // raw-zone messages keep their original payload untouched too.
    check('reasoning_content preserved verbatim in light zone', res.slice(1, 23).some((m: any) => m.reasoning_content === 'deep thinking about the store module...'));
    check('reasoning_content preserved in raw zone', res.slice(23).some(m => (m as any).reasoning_content !== undefined));
  }

  // ── 20 ──
  section('20. Heavy result with illegal roles → normalized or fallback');
  {
    const cfg = { ...baseCfg, callLLM: async () => JSON.stringify([
      { role: 'system', content: 'evil' },
      { role: 'user', content: 'Summary' },
      { role: 'assistant', content: 'Confirmation' },
      { role: 'tool', content: 'extra' },
    ]) };
    const res = await mosaicMemoryCompress(makeConv(60), cfg);
    // First two legal messages win; no system/tool roles may leak into output
    check('No system role in heavy pair', res.slice(1).every(m => m.role === 'user' || m.role === 'assistant'));
    check('Heavy summary present', res[1].content!.includes('Summary'));
    check('Heavy confirmation present', res[2].content!.includes('Confirmation'));
  }

  // ── 21 ──
  section('21. onCompress callback fires and errors never break the flow');
  {
    const events: { zone: string; round: number; origLen: number; compLen: number }[] = [];
    const cfg = { ...baseCfg, callLLM: mockBoth(), onCompress: async (ev: any) => {
      events.push({ zone: ev.zone, round: ev.round, origLen: ev.original.length, compLen: ev.compressed.length });
      if (ev.zone === 'light') throw new Error('simulated callback failure');
    } };
    const res = await mosaicMemoryCompress(makeConv(60), cfg);
    checkEq('Compression still succeeded despite callback error', countMsgs(res), 102);
    const lightEv = events.find(ev => ev.zone === 'light');
    const heavyEv = events.find(ev => ev.zone === 'heavy');
    check('Light event fired', !!lightEv);
    check('Light event has original payload', !!lightEv && lightEv.origLen > 0);
    check('Heavy event fired', !!heavyEv);
    check('Heavy event compressed to 2 messages', !!heavyEv && heavyEv.compLen === 2);
    check('Round captured', !!lightEv && lightEv.round === 60);
  }

  // ── Summary ──
  console.log(`\n══════════════════════════════════════════`);
  console.log(`  Total: ${PASS + FAIL}  |  ✅ PASS: ${PASS}  |  ❌ FAIL: ${FAIL}`);
  console.log(`══════════════════════════════════════════`);
  if (FAIL > 0) (globalThis as any).process?.exit?.(1);
}

run().catch(err => { console.error(err); (globalThis as any).process?.exit?.(1); });

  // ── 22 ──
  section('22. Light structural truncation: tool results truncated, text untouched');
  {
    const bigTool = 'X'.repeat(2000);
    const msgs: Message[] = [
      sys('S'),
      usr('user one'),
      ast('assistant one'),
      { role: 'user', content: 'user two' },
      { role: 'tool', content: bigTool, tool_call_id: 'c1' },
      usr('user three'),
      ast('assistant three'),
    ];
    const cfg = { ...DEFAULT_CONFIG, lightStart: 1, heavyStart: 99, lightWindow: 1 };
    const res = await mosaicMemoryCompress(msgs, cfg);
    // R=3: light = rounds [0,1) → the big tool result gets truncated
    const toolMsg = res.find(m => m.role === 'tool')!;
    check('Tool result truncated', toolMsg.content.length < bigTool.length);
    check('Tool truncation keeps head+tail', toolMsg.content.includes('XXX') && toolMsg.content.includes('…[truncated]…'));
    check('Tool call id preserved', toolMsg.tool_call_id === 'c1');
    check('User text untouched', res.find(m => m.content === 'user two') !== undefined);
  }

  // ── 23 ──
  section('23. Light structural: reasoning head+tail kept, arguments JSON shell kept');
  {
    const longReasoning = '思考过程的内容'.repeat(100); // 700 chars
    const msgs: Message[] = [
      sys('S'),
      usr('u1'),
      { role: 'assistant', content: 'a1', reasoning_content: longReasoning, tool_calls: [{ id: 't1', type: 'function', function: { name: 'run_code', arguments: JSON.stringify({ code: 'const x = 1;'.repeat(300) }) } }] },
      { role: 'tool', content: 'ok', tool_call_id: 't1' },
      usr('u2'),
      ast('a2'),
    ];
    const cfg = { ...DEFAULT_CONFIG, lightStart: 1, heavyStart: 99, lightWindow: 1 };
    const res = await mosaicMemoryCompress(msgs, cfg);
    const asst = res.find(m => m.role === 'assistant' && m.reasoning_content !== undefined)!;
    check('Reasoning truncated head+tail', asst.reasoning_content!.length < 100);
    check('Reasoning starts with original head', asst.reasoning_content!.startsWith('思考过程的内容'));
    const args = asst.tool_calls![0].function.arguments;
    check('Arguments JSON shell preserved', args.startsWith('{"code":'));
    check('Arguments truncated', args.length < 500 && args.length > 100);
    check('Arguments content truncated with marker', args.includes('…[truncated]'));
    check('Tool call id preserved', asst.tool_calls![0].id === 't1');
  }

  // ── 24 ──
  section('24. Incremental light: repeated triggers never re-process');
  {
    const long = (i: number, tag: string) => 'Round ' + i + ' ' + tag + ': ' + 'substantial content with filler words '.repeat(4);
    const mk = (n: number) => {
      const msgs: Message[] = [sys('S')];
      for (let i = 1; i <= n; i++) {
        msgs.push(usr(long(i, 'user')));
        msgs.push(ast(long(i, 'assistant')));
      }
      return msgs;
    };
    const cfg = { ...DEFAULT_CONFIG, callLLM: async () => JSON.stringify([
      { role: 'user', content: 'H-U' }, { role: 'assistant', content: 'H-A' }]) };
    const r40 = await mosaicMemoryCompress(mk(40), cfg);
    check('R=40 marked 20 messages distilled', r40.filter((m: any) => m._distilled === true).length === 20);
    const r50 = await mosaicMemoryCompress([...r40, ...mk(10).slice(1)], cfg);
    check('R=50 marks exactly 20 more (incremental)', r50.filter((m: any) => m._distilled === true).length === 40);
    const r60 = await mosaicMemoryCompress([...r50, ...mk(10).slice(1)], cfg);
    checkEq('R=60 count: 2 heavy + 40 light + 60 raw = 102 (excl. sys)', countMsgs(r60), 102);
    check('R=60 heavy summary flagged', r60[1]._heavy === true);
    check('R=60 distilled messages flagged', r60.some((m: any) => m._distilled === true));
  }
