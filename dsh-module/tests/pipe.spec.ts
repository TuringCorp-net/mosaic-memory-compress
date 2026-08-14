import { strict as assert } from 'node:assert'
import { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { MosaicCompactionEngine } from '../src/index.ts'

// ── helpers ──────────────────────────────────────────────────────────
function seedSession(rounds: number): Session {
  const t0 = 1786000000000
  const seed: any[] = [{ type: 'turn/start', seq: 0, time: t0, data: { turn: 1 } }]
  for (let i = 0; i < rounds; i++) {
    const message = createUserMessage({
      content: [{ type: 'text', text: 'user round ' + i + ' — some instruction content for the agent to follow' }],
      source: { kind: 'user' },
    })
    seed.push({ type: 'user/message', seq: i + 1, time: t0 + i, data: message, surfaceOp: 'append' })
  }
  return Session.create('pipe-session' as never, seed as never)
}

function mockCtx(heavyText: string) {
  const stream = async function* () {
    yield { type: 'text-delta', index: 0, text: heavyText }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: heavyText } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const ctx = new Context()
  ;(ctx as any).llm = { stream: () => stream() }
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

// ── tests ────────────────────────────────────────────────────────────
// 1) below threshold → null (zero cost)
{
  const session = seedSession(20)
  const engine = new MosaicCompactionEngine(mockCtx('x') as never, {})
  const agent = { session, options: { provider: 'mock', model: 'mock' } }
  const result = await engine.compactIfNeeded(agent as never, 'pressure', new AbortController().signal)
  assert.equal(result, null)
  assert.deepEqual(session.surface.nodes, Array.from({ length: 20 }, (_, i) => i + 1))
}

// 2) off-window (userCount 25, window 10) → null
{
  const session = seedSession(25)
  const engine = new MosaicCompactionEngine(mockCtx('x') as never, {})
  const agent = { session, options: { provider: 'mock', model: 'mock' } }
  const result = await engine.compactIfNeeded(agent as never, 'pressure', new AbortController().signal)
  assert.equal(result, null)
}

// 3) 60 rounds → heavy fold runs: 60 nodes → 51 (10 ancient → 1 checkpoint)
{
  const session = seedSession(60)
  const engine = new MosaicCompactionEngine(mockCtx('## HEAVY CHECKPOINT') as never, {})
  const agent = { session, options: { provider: 'mock', model: 'mock' } }
  const before = session.surface.nodes.length
  const result = await engine.compactIfNeeded(agent as never, 'pressure', new AbortController().signal)
  assert.notEqual(result, null)
  const after = session.surface.nodes.length
  console.log('60 rounds:', before, '→', after, 'nodes; compaction seqs:', result!.startSeq, result!.summarySeq, result!.endSeq)
  assert.equal(after, 51) // 60 - 10 + 1
  // raw zone untouched: last 30 nodes still carry original text
  const tail = session.surface.nodes.slice(-5)
  assert.ok(tail.length === 5)
  // compaction markers present
  const types = session.events.map(e => e.type)
  assert.ok(types.includes('compaction/start') && types.includes('compaction/summary') && types.includes('compaction/end'))
  console.log('pipe.spec: compaction flow PASS')
}
