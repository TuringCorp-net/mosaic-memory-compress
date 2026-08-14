import { strict as assert } from 'node:assert'
import { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

// Build a seed: 3 appended user messages (no turn structure needed for surface mechanics)
const seed = [0, 1, 2].map(i => {
  const message = createUserMessage({
    content: [{ type: 'text', text: 'round ' + i }],
    source: { kind: 'user' },
  })
  return {
    type: 'user/message' as const,
    seq: i,
    time: 1786000000000 + i,
    data: message,
    surfaceOp: 'append' as const,
  }
})
const session = Session.create('smoke-session' as never, seed as never)
assert.deepEqual(session.surface.nodes, [0, 1, 2])

// Single-node replacement: swap node seq 2 with a distilled version
const replacement = createUserMessage({
  content: [{ type: 'text', text: 'round 1 DISTILLED' }],
  source: { kind: 'user' },
})
const ev = session.append('user/message', replacement, {
  surfaceOp: { op: 'replace', start: 1, end: 1 },
  sourceEventSeqs: [1],
})
assert.equal((ev.surfaceOp as { op?: string } | 'append') !== 'append' && (ev.surfaceOp as { op?: string }).op, 'replace')
// surface keeps count and order (1:1 replacement)
assert.deepEqual(session.surface.nodes, [0, ev.seq, 2])
// replacement shadows the original (original not on surface)
assert.equal(session.surface.nodes.includes(1), false)

// Replace an assistant message (role preserved) — user/message replacement of role user:
console.log('smoke.spec: single-node surface replacement PASS')
