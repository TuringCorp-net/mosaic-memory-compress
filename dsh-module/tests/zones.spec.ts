import { strict as assert } from 'node:assert'
import { zoneBoundaries } from '../src/zones.ts'

// 60 pure dialogue rounds (user + assistant each)
assert.deepEqual(zoneBoundaries(60, 30, 50), { rawFrom: 30, heavyFrom: 10 })

// below threshold: everything raw
assert.deepEqual(zoneBoundaries(25, 30, 50), { rawFrom: 0, heavyFrom: 0 })

// heavy not reached: light covers the middle only
assert.deepEqual(zoneBoundaries(40, 30, 50), { rawFrom: 10, heavyFrom: 0 })

// exact boundary: 30 rounds → all raw
assert.deepEqual(zoneBoundaries(30, 30, 50), { rawFrom: 0, heavyFrom: 0 })

// 50 rounds → heavy boundary at 0 (light 0..20, no heavy yet)
assert.deepEqual(zoneBoundaries(50, 30, 50), { rawFrom: 20, heavyFrom: 0 })

// 51 rounds → heavyFrom 1: rounds 1..20 light, round 0 heavy
assert.deepEqual(zoneBoundaries(51, 30, 50), { rawFrom: 21, heavyFrom: 1 })

// custom thresholds (tunable vivid window)
assert.deepEqual(zoneBoundaries(100, 20, 60), { rawFrom: 80, heavyFrom: 40 })

// invariant: light window size = lightStart - heavyStart rounds
const b = zoneBoundaries(120, 30, 50)
assert.equal(b.rawFrom - b.heavyFrom, 20)
assert.equal(b.rawFrom, 90)
assert.equal(b.heavyFrom, 70)

// tool-heavy conversation: userCount counts USER nodes only
assert.deepEqual(zoneBoundaries(100, 30, 50), { rawFrom: 70, heavyFrom: 50 })

console.log('zones.spec: all assertions passed')
