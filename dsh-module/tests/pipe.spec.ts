import { strict as assert } from 'node:assert'
import { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { deriveEventMessage } from '@deepseek-ai/dsh-session'
import { MosaicMemoryCompactionEngine } from '../src/index.ts'

function seedSession(rounds: number): Session {
  const t0 = 1786000000000
  const seed: any[] = [{ type: 'turn/start', seq: 0, time: t0, data: { turn: 1 } }]
  for (let i = 0; i < rounds; i++) {
    const message = createUserMessage({
      content: [{ type: 'text', text: 'user round ' + i + ' — ' + 'instruction content for the agent to follow, with enough substance to exceed the light skip threshold and get distilled. '.repeat(3) }],
      source: { kind: 'user' },
    })
    seed.push({ type: 'user/message', seq: i + 1, time: t0 + i, data: message, surfaceOp: 'append' })
  }
  return Session.create('pipe-session' as never, seed as never)
}

function messageOf(session: Session, seq: number): string {
  const ev = session.events.find(e => e.seq === seq)!
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
      logRevision: s.events.length,
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
  const engine = new MosaicMemoryCompactionEngine(mockCtx() as never, {})
  const agent = { session, options: { provider: 'mock', model: 'mock' } }
  const result = await engine.compactIfNeeded(agent as never, 'pressure', new AbortController().signal)
  assert.equal(result, null)
  assert.deepEqual(session.surface.nodes, Array.from({ length: 20 }, (_, i) => i + 1))
}

// 2) off-window (userCount 25) → null
{
  const session = seedSession(25)
  const engine = new MosaicMemoryCompactionEngine(mockCtx() as never, {})
  const agent = { session, options: { provider: 'mock', model: 'mock' } }
  const result = await engine.compactIfNeeded(agent as never, 'pressure', new AbortController().signal)
  assert.equal(result, null)
}

// 3) 60 rounds: structural light (text verbatim) + heavy fold, raw untouched
{
  const session = seedSession(60)
  const engine = new MosaicMemoryCompactionEngine(mockCtx() as never, {})
  const agent = { session, options: { provider: 'mock', model: 'mock' } }
  const result = await engine.compactIfNeeded(agent as never, 'pressure', new AbortController().signal)
  assert.notEqual(result, null)
  const nodes = session.surface.nodes
  assert.equal(nodes.length, 31) // 60 - 30 + 1 (heavyStart=30 default)

  const texts = nodes.map(seq => messageOf(session, seq))
  // light zone (30 messages, rounds 0..29): user TEXT stays verbatim
  // (structural light never rewrites text)
  // light zone = rounds 30..49 (20 user msgs, text verbatim)
  const lightVerbatim = texts.filter(t => t.startsWith('user round 3') || t.startsWith('user round 4'))
  assert.equal(lightVerbatim.length, 20)
  // raw zone = rounds 50..59 (10 user msgs) verbatim
  const raw = texts.filter(t => t.startsWith('user round 5'))
  assert.equal(raw.length, 10)
  // heavy checkpoint present (official preamble + <compacted-summary> framing)
  assert.ok(texts.some(t => t.includes('## HEAVY CHECKPOINT')))
  // markers present
  const types = session.events.map(e => e.type)
  assert.ok(types.includes('compaction/start') && types.includes('compaction/summary') && types.includes('compaction/end'))
  console.log('3) 60 rounds: light text verbatim (' + lightVerbatim.length + '), raw (' + raw.length + '), heavy fold 60→31 PASS')
}

// 4) structural light is pure (no LLM involvement): heavy LLM failure still completes
{
  const session = seedSession(60)
  const engine = new MosaicMemoryCompactionEngine(mockCtx({ failLight: true }) as never, {})
  const agent = { session, options: { provider: 'mock', model: 'mock' } }
  const result = await engine.compactIfNeeded(agent as never, 'pressure', new AbortController().signal)
  assert.notEqual(result, null)
  const texts = session.surface.nodes.map(seq => messageOf(session, seq))
  // text untouched everywhere (structural light) — light+raw zones verbatim
  assert.ok(texts.some(t => t.startsWith('user round 3')) && texts.some(t => t.startsWith('user round 5')))
  console.log('4) structural light: text untouched, heavy completes PASS')
}

console.log('pipe.spec: all scenarios passed')
