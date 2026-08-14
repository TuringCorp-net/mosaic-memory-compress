/**
 * Position-is-age zone boundaries, in memory rounds (user nodes).
 * Round 0 is the OLDEST; the newest round is userCount - 1.
 *
 *   rounds [0, heavyFrom)        → heavy zone (fold into checkpoint)
 *   rounds [heavyFrom, rawFrom)  → light zone (per-node replacement)
 *   rounds [rawFrom, userCount)  → raw zone (untouched)
 *
 * Pure function: no DSH dependency, unit-testable in isolation.
 */
export function zoneBoundaries(
  userCount: number,
  lightStart: number,
  heavyStart: number,
): { rawFrom: number; heavyFrom: number } {
  return {
    rawFrom: Math.max(0, userCount - lightStart),
    heavyFrom: Math.max(0, userCount - heavyStart),
  }
}
