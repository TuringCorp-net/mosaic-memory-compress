/**
 * Cross-version reality check: the module's own dev tree shadows
 * @deepseek-ai/dsh-session (0.1.0), so the capability probe validates against
 * the WRONG implementation while the host session object validates with its
 * own (0.1.5). This reproduces the real deployment path and asserts the
 * write-side self-correction flips the spelling and succeeds.
 */
import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'
import { MosaicMemoryCompactionEngine, detectedReplaceFields, opStartOf, opEndOf } from '../src/index.ts'

const require015 = createRequire('/home/uncleli/.dsh-zero/runtime-0.1.5/node_modules/')
const ds015 = require015('@deepseek-ai/dsh-session') as any
const llm015 = require015('@deepseek-ai/dsh-llm') as any

// probe here must have validated against the repo's 0.1.0 (the shadowing bug)
console.log('probe (shadowed dev tree):', detectedReplaceFields())

const t0 = 1789000000000
const seed: any[] = [{ type: 'turn/start', seq: 0, time: t0, data: { turn: 1 } }]
let s = 1
for (let i = 0; i < 6; i++) {
  seed.push({
    type: 'user/message', seq: s++, time: t0 + i,
    data: llm015.createUserMessage({
      content: [{ type: 'text', text: 'round ' + i + ' instruction '.repeat(6) }],
      source: { kind: 'user' },
    }),
    surfaceOp: 'append',
  })
  // assistant node with reasoning — the host makes these immutable on 0.1.5
  seed.push({
    type: 'assistant/message', seq: s++, time: t0 + i,
    data: {
      turn: i + 1, step: 1,
      // 0.1.5 assistant/message events embed their source stream — this is
      // exactly why the host forbids sourceEventSeqs on them.
      stream: [],
      message: llm015.createAssistantMessage({
        content: [{ type: 'reasoning', text: 'thinking about round ' + i + ' '.repeat(30) }, { type: 'text', text: 'ok ' + i }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
    },
    surfaceOp: 'append',
  })
}
const session = ds015.Session.create('cross-version-015', seed)
console.log('host session (0.1.5) created, nodes =', session.surface.nodes.length)

const { Context } = require015('@deepseek-ai/cordis')
const ctx = new Context()
ctx.llm = { stream: async function* () {
  yield { type: 'text-delta', index: 0, text: 'SUMMARY' }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: 'SUMMARY' } }
  yield { type: 'finish', reason: { kind: 'stop' } }
} }
ctx.tokenMeter = { measure: () => ({ nodes: [] }), estimateMessage: () => 1 }
const engine = new MosaicMemoryCompactionEngine(ctx, {
  lightStart: 1, lightWindow: 1, heavyStart: 2, heavyWindow: 1, sessionAllowlist: ['*'],
})
const agent = { session, options: { provider: 'mock', model: 'mock' } }

const result = await engine.compactIfNeeded(agent as never, 'pressure', new AbortController().signal)
const events = session.snapshotEvents()
const replaces = events.filter((e: any) => e.surfaceOp && typeof e.surfaceOp === 'object')
console.log('replace events written:', replaces.length, '| op keys:', JSON.stringify(Object.keys(replaces[0].surfaceOp)))
assert.ok(replaces.length > 0, 'light/heavy must have written replacements')
assert.deepEqual(Object.keys(replaces[0].surfaceOp), ['op', 'startSeq', 'endSeq'],
  'self-correction must switch to the 0.1.5 spelling')
assert.equal(detectedReplaceFields(), 'seq', 'correction is cached for the process')
assert.notEqual(result, null, 'heavy fold completed')
try {
  const folded = ds015.foldSurface(events.map((e: any) => ({ ...e })))
  console.log('REPLAY OK (0.1.5 re-accepts the compressed log), nodes =', folded.nodes.length)
} catch (err) {
  assert.fail('replay rejected the compressed log: ' + (err as Error).message)
}
// Read-side fix: range-fold detection must read BOTH spellings. A naive
// op.start/op.end read returns undefined on 0.1.5 and silently fails to
// invalidate the round counter.
assert.notEqual(opStartOf({ op: 'replace', startSeq: 1, endSeq: 5 }),
  opEndOf({ op: 'replace', startSeq: 1, endSeq: 5 }), '0.1.5 range fold is detected')
assert.equal(opStartOf({ op: 'replace', startSeq: 3, endSeq: 3 }),
  opEndOf({ op: 'replace', startSeq: 3, endSeq: 3 }), '0.1.5 1:1 replace is not a fold')
assert.notEqual(opStartOf({ op: 'replace', start: 1, end: 5 }),
  opEndOf({ op: 'replace', start: 1, end: 5 }), 'legacy range fold is detected')
assert.equal(opStartOf({ op: 'replace', start: 2, end: 2 }),
  opEndOf({ op: 'replace', start: 2, end: 2 }), 'legacy 1:1 replace is not a fold')
// 0.1.5: assistant nodes must be skipped, not replaced
const assistantNodes = session.surface.nodes.filter((n: number) => session.eventAt(n)?.type === 'assistant/message')
assert.ok(assistantNodes.length > 0, 'session still holds assistant nodes (skipped, not removed)')
assert.equal(engine['assistantImmutable'], true, 'engine learned the host invariant')
console.log('assistant-skip PASS: ' + assistantNodes.length + ' assistant nodes kept intact on 0.1.5, user/tool nodes still dehydrated')
console.log('read-side fix PASS: both spellings recognised (range fold vs 1:1)')
console.log('cross-version self-correction PASS')
