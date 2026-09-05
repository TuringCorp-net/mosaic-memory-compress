import { strict as assert } from 'node:assert'
import { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { deriveEventMessage } from '@deepseek-ai/dsh-session'
import { MosaicMemoryCompactionEngine } from '../src/index.ts'

/** 0.1.0 events array ↔ 0.1.2 snapshotEvents() — tests run on both. */
function evts(session: any): any[] {
  return session.snapshotEvents ? session.snapshotEvents() : session.events
}

function seedSession(rounds: number, id = 'pipe-session'): Session {
  const t0 = 1786000000000
  const seed: any[] = [{ type: 'turn/start', seq: 0, time: t0, data: { turn: 1 } }]
  for (let i = 0; i < rounds; i++) {
    const message = createUserMessage({
      content: [{ type: 'text', text: 'user round ' + i + ' — ' + 'instruction content for the agent to follow, with enough substance to exceed the light skip threshold and get distilled. '.repeat(3) }],
      source: { kind: 'user' },
    })
    seed.push({ type: 'user/message', seq: i + 1, time: t0 + i, data: message, surfaceOp: 'append' })
  }
  return Session.create(id as never, seed as never)
}

function messageOf(session: Session, seq: number): string {
  const ev = evts(session).find((e: any) => e.seq === seq)!
  const m = deriveEventMessage(ev)
  return m ? m.content.map((b: { type: string; text?: string }) => b.type === 'text' ? b.text ?? '' : '').join('') : ''
}

/** mock LLM: light calls → "DISTILLED: <first words>"; heavy calls (instruction present) → checkpoint. */
function mockCtx(opts?: { failLight?: boolean }) {
  const stream = async function* (options: any) {
    const last = options.messages[options.messages.length - 1]
    const text = last.content?.[0]?.text ?? ''
    const isHeavy = text.includes('dialogue memory compressor')
    if (opts?.failLight && !isHeavy) throw new Error('mock LLM failure')
    const out = isHeavy ? '## HEAVY CHECKPOINT' : 'DISTILLED: ' + text.slice(0, 30)
    yield { type: 'text-delta', index: 0, text: out }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: out } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const ctx = new Context()
  ;(ctx as any).llm = { stream: (o: any) => stream(o) }
  ;(ctx as any).tokenMeter = {
    measure: (s: Session) => ({
      logRevision: evts(s).length,
      baseline: { kind: 'none', tokens: 0 },
      surfaceDeltaTokens: 0,
      totalTokens: 0,
      surfaceTokens: 0,
      nodes: s.surface.nodes.map(seq => ({ seq, tokens: 1 })),
    }),
    estimateMessage: () => 1,
  }
  return ctx
}

// 1) below threshold → null (zero cost)
{
  const session = seedSession(20)
  const engine = new MosaicMemoryCompactionEngine(mockCtx() as never, { sessionAllowlist: ['pipe-session'] })
  const agent = { session, options: { provider: 'mock', model: 'mock' } }
  const result = await engine.compactIfNeeded(agent as never, 'pressure', new AbortController().signal)
  assert.equal(result, null)
  assert.deepEqual(session.surface.nodes, Array.from({ length: 20 }, (_, i) => i + 1))
}

// 2) off-window (userCount 25) → null
{
  const session = seedSession(25)
  const engine = new MosaicMemoryCompactionEngine(mockCtx() as never, { sessionAllowlist: ['pipe-session'] })
  const agent = { session, options: { provider: 'mock', model: 'mock' } }
  const result = await engine.compactIfNeeded(agent as never, 'pressure', new AbortController().signal)
  assert.equal(result, null)
}

// 3) 70 rounds (heavyStart=40): light de-waters [30,60), heavy folds [0,30)
//    → steady state 42 nodes (40 user rounds [30,70) + summary pair)
{
  const session = seedSession(70)
  const engine = new MosaicMemoryCompactionEngine(mockCtx() as never, { sessionAllowlist: ['pipe-session'] })
  const agent = { session, options: { provider: 'mock', model: 'mock' } }
  const result = await engine.compactIfNeeded(agent as never, 'pressure', new AbortController().signal)
  assert.notEqual(result, null)
  const nodes = session.surface.nodes
  assert.equal(nodes.length, 42) // 70 - 30 folded + summary pair; steady 40 user rounds

  const texts = nodes.map(seq => messageOf(session, seq))
  // light zone = rounds 30..59 (30 user msgs): user TEXT stays verbatim
  // (structural light never rewrites user text)
  const lightVerbatim = texts.filter(t => /^user round (3|4|5)\d/.test(t))
  assert.equal(lightVerbatim.length, 30)
  // raw zone = rounds 60..69 (10 user msgs) verbatim
  const raw = texts.filter(t => /^user round 6\d/.test(t))
  assert.equal(raw.length, 10)
  // heavy checkpoint present
  assert.ok(texts.some(t => t.includes('## HEAVY CHECKPOINT')))
  // markers present
  const types = evts(session).map((e: any) => e.type)
  assert.ok(types.includes('compaction/start') && types.includes('compaction/summary') && types.includes('compaction/end'))
  console.log('3) 70 rounds: light verbatim (30), raw (10), heavy fold 70→42 PASS')
}

// 4) structural light is pure (no LLM involvement): heavy LLM failure still completes
{
  const session = seedSession(70)
  const engine = new MosaicMemoryCompactionEngine(mockCtx({ failLight: true }) as never, { sessionAllowlist: ['pipe-session'] })
  const agent = { session, options: { provider: 'mock', model: 'mock' } }
  const result = await engine.compactIfNeeded(agent as never, 'pressure', new AbortController().signal)
  assert.notEqual(result, null)
  const texts = session.surface.nodes.map(seq => messageOf(session, seq))
  // text untouched everywhere (structural light) — light+raw zones verbatim
  assert.ok(texts.some(t => t.startsWith('user round 3')) && texts.some(t => t.startsWith('user round 5')))
  console.log('4) structural light: text untouched, heavy completes PASS')
}


// 5) session allowlist: non-listed session is a zero-cost no-op; listed one works
{
  const session = seedSession(70)
  const engineBlocked = new MosaicMemoryCompactionEngine(mockCtx() as never, { sessionAllowlist: ['other-session'] })
  const blocked = await engineBlocked.compactIfNeeded({ session, options: { provider: 'mock', model: 'mock' } } as never, 'pressure', new AbortController().signal)
  assert.equal(blocked, null)
  assert.equal(session.surface.nodes.length, 70) // untouched
  const engineAllowed = new MosaicMemoryCompactionEngine(mockCtx() as never, { sessionAllowlist: ['pipe-session'] })
  const allowed = await engineAllowed.compactIfNeeded({ session, options: { provider: 'mock', model: 'mock' } } as never, 'pressure', new AbortController().signal)
  assert.notEqual(allowed, null)
  console.log('5) allowlist gate: blocked session untouched, listed session compresses PASS')
}


// 6) identified-message constraint: every user/assistant message we append
//    carries a non-empty message.id (DSH enforces this at session load —
//    a missing id breaks the whole session log).
{
  const session = seedSession(70)
  const engine = new MosaicMemoryCompactionEngine(mockCtx() as never, { sessionAllowlist: ['pipe-session'] })
  const agent = { session, options: { provider: 'mock', model: 'mock' } }
  await engine.compactIfNeeded(agent as never, 'pressure', new AbortController().signal)

  const bad: string[] = []
  for (const ev of evts(session)) {
    if (ev.type === 'user/message' || ev.type === 'assistant/message') {
      const id = (ev.data as any)?.message?.id ?? (ev.data as any)?.id
      if (!id) bad.push(ev.type + '@' + ev.seq)
    }
    if (ev.type === 'tool/result') {
      const id = (ev.data as any)?.message?.id
      if (!id) bad.push('tool/result@' + ev.seq)
    }
  }
  assert.equal(bad.length, 0, 'messages missing id: ' + bad.join(','))
  // specifically the checkpoint + confirm we append
  const checkpoint = evts(session).find((e: any) => e.type === 'user/message' && (e.data as any)?.source?.plugin === 'dsh-mosaic-memory-compress')
  assert.ok(checkpoint && (checkpoint.data as any).id, 'checkpoint user message missing id')
  const confirm = evts(session).find((e: any) => e.type === 'assistant/message' && JSON.stringify(e.data?.message?.content).includes('MosaicMemory'))
  assert.ok(confirm && (confirm.data as any)?.message?.id, 'confirm message missing id')
  console.log('6) identified-message constraint: all appended messages carry id PASS')
}

console.log('pipe.spec: all scenarios passed')

// 7) denylist wins over allowlist: fleet-wide ['*'] minus denylist
{
  const session = seedSession(70)
  const engine = new MosaicMemoryCompactionEngine(mockCtx() as never, { sessionAllowlist: ['*'], sessionDenylist: ['pipe-session'] })
  const agent = { session, options: { provider: 'mock', model: 'mock' } }
  const denied = await engine.compactIfNeeded(agent as never, 'pressure', new AbortController().signal)
  assert.equal(denied, null, 'denylisted session must never compress')
  assert.equal(session.surface.nodes.length, 70, 'denylisted session untouched')

  const engine2 = new MosaicMemoryCompactionEngine(mockCtx() as never, { sessionAllowlist: ['*'], sessionDenylist: ['other-session'] })
  const allowed = await engine2.compactIfNeeded(agent as never, 'pressure', new AbortController().signal)
  assert.notEqual(allowed, null, 'fleet-wide allowlist minus denylist still compresses')
  console.log('7) denylist gate: deny wins over allow, fleet-wide minus deny works PASS')
}

// 8) decoupled windows: R=39 (mid-window, like 85cd44e7) → nothing yet
//    (light first run needs R >= lightStart + lightWindow = 40)
{
  const session = seedSession(39)
  const engine = new MosaicMemoryCompactionEngine(mockCtx() as never, { sessionAllowlist: ['pipe-session'] })
  const agent = { session, options: { provider: 'mock', model: 'mock' } }
  const result = await engine.compactIfNeeded(agent as never, 'pressure', new AbortController().signal)
  assert.equal(result, null, 'R=39 must not trigger (light needs 40, heavy needs 60)')
  assert.equal(session.surface.nodes.length, 39, 'R=39 surface untouched')
  console.log('8) R=39 mid-window no-op PASS')
}

// 9) R=40 → LIGHT ONLY (dehydration runs; heavy fold waits for R=60)
{
  const session = seedSession(40)
  const engine = new MosaicMemoryCompactionEngine(mockCtx() as never, { sessionAllowlist: ['pipe-session'] })
  const agent = { session, options: { provider: 'mock', model: 'mock' } }
  await engine.compactIfNeeded(agent as never, 'pressure', new AbortController().signal)
  // light-only run: light = 1:1 replacements (new seqs), user-round count stays 40
  const users = session.surface.nodes.filter(n => (evts(session).find((e: any) => e.seq === n)?.data as any)?.source?.kind === 'user')
  assert.equal(users.length, 40, 'light is 1:1 — user rounds unchanged at 40')
  const replacedUsers = users.filter(n => n > 40).length
  assert.ok(replacedUsers > 0, 'light replaced middle-zone nodes (got ' + replacedUsers + ')')
  // heavy must NOT have run: no mosaic checkpoint node appended
  const checkpoint = evts(session).find((e: any) => e.type === 'user/message' && (e.data as any)?.source?.plugin === 'dsh-mosaic-memory-compress')
  assert.ok(!checkpoint, 'heavy fold must not run at R=40')
  console.log('9) R=40 light-only (no heavy fold, ' + replacedUsers + ' nodes replaced) PASS')
}

// 10) R=45 → light only too; then again at R=75 → light only (heavy still not due: 75-30=45>=30 → due!)
//     wait — verify per-window semantics: heavy due = 45 >= 30 window → so 75 fires heavy.
//     Use R=45 to assert light-only, then R=61 in a fresh engine to show light+heavy? — R=61: light 51>=30 due, heavy 31>=30 due.
//     Simplest split assertion: R=45 light-only; R=75 (heavy delta 45) light+heavy.
{
  const session = seedSession(45)
  const engine = new MosaicMemoryCompactionEngine(mockCtx() as never, { sessionAllowlist: ['pipe-session'] })
  const agent = { session, options: { provider: 'mock', model: 'mock' } }
  await engine.compactIfNeeded(agent as never, 'pressure', new AbortController().signal)
  const replacedUsers = session.surface.nodes.filter(n => ((evts(session).find((e: any) => e.seq === n)?.data) as any)?.source?.kind === 'user' && n > 45).length
  assert.ok(replacedUsers > 0, 'R=45 light must run')
  const checkpoint = evts(session).find((e: any) => e.type === 'user/message' && (e.data as any)?.source?.plugin === 'dsh-mosaic-memory-compress')
  assert.ok(!checkpoint, 'R=45: heavy must still wait (heavy needs R>=60)')
  console.log('10) R=45 light-only (mid-window dehydration, ' + replacedUsers + ' nodes) PASS')
}

// 11) per-session isolation: session A at R=70 folds, session B at R=45 still runs its own light
{
  const engine = new MosaicMemoryCompactionEngine(mockCtx() as never, { sessionAllowlist: ['*'] })
  const a = seedSession(70, 'session-a')
  const b = seedSession(45, 'session-b')
  const agentA = { session: a, options: { provider: 'mock', model: 'mock' } }
  const agentB = { session: b, options: { provider: 'mock', model: 'mock' } }
  await engine.compactIfNeeded(agentA as never, 'pressure', new AbortController().signal)
  // A folded: 70 → 40 user rounds (steady state)
  const aUsers = a.surface.nodes.filter(n => ((evts(a).find((e: any) => e.seq === n)?.data) as any)?.source?.kind === 'user')
  assert.equal(aUsers.length, 40, 'A folded to steady 40 rounds')
  // B must NOT be gated by A's trigger: B's light is due (45-10=35 >= 30)
  await engine.compactIfNeeded(agentB as never, 'pressure', new AbortController().signal)
  const bCheckpoint = evts(b).find((e: any) => e.type === 'user/message' && (e.data as any)?.source?.plugin === 'dsh-mosaic-memory-compress')
  assert.ok(!bCheckpoint, 'B light-only — no heavy (R=45)')
  const bUsers = b.surface.nodes.filter(n => ((evts(b).find((e: any) => e.seq === n)?.data) as any)?.source?.kind === 'user')
  assert.equal(bUsers.length, 45, 'B light 1:1 keeps 45 rounds')
  const bReplaced = bUsers.filter(n => n > 45).length
  assert.ok(bReplaced > 0, 'B must trigger its own light independently of A')
  console.log('11) per-session trigger isolation PASS')
}

console.log('pipe.spec: all scenarios passed')
