# Changelog

All notable changes to MosaicMemoryCompress and its DSH adapter.
Dates are local (Asia/Shanghai).

## Unreleased — 2026-09-10 (docs)

**Upgrade hazard: sessions compressed before v1.3.2 on DSH ≤ 0.1.2 cannot be
loaded after a 0.1.5 upgrade.**

- **Documented**: DSH 0.1.5's `v0→v1→v2→v3` session migration refuses a stored
  log that contains mosaic's pre-v1.3.2 *assistant* 1:1 replacements
  (`assistant/message … chunk provenance is not one complete ordered attempt`).
  The stored log is left untouched — nothing is erased — but the conversation
  no longer opens, and no plugin-side repair exists (10+ in-place rewrites each
  failed on a different log invariant; `seq` in v0/v1 is a logical chunk-space
  counter, so rows cannot simply be renumbered). README (EN / zh-CN) now warns
  *before* the host upgrade and points at the new salvage script; the root
  cause, the measured invariants, the migration source coordinates and the
  measured blast radius are in `dsh-module/INTEGRATION-NOTES.md` §19.
- **Added**: `scripts/salvage-session.py` — read-only transcript salvage for an
  unloadable session log, v0/v1 `session.jsonl.zstd` or 0.1.5's
  `session.v3.jsonl.zstd` (deduplicates surface copies, drops mosaic fold
  notices, never writes to the source).
- **Guidance**: mount mosaic v1.3.2+ *before* upgrading DSH to 0.1.5; treat any
  conversation compressed on ≤ 0.1.2 as salvage-only across that boundary.

## v1.3.3 — 2026-09-10

**Single-checkpoint fold — fixes stored-session corruption on 0.1.5.**

- **Fixed**: the fold appended a second `assistant/message` ("ancient rounds
  folded …"). 0.1.5 requires every assistant event to carry settlement fields
  (`turn`, `step`, **`stream`** — the reason assistant events "embed their
  source stream"); without `stream` the session loader reports the stored
  session as **corrupt** and it stops loading. The fold now writes exactly ONE
  `user/message` checkpoint (matching the official backend) with the fold
  notice in its text; no assistant companion is appended. Steady state is
  therefore 41 messages (40 user rounds + 1 checkpoint), not 42.
- **Tests**: `crossversion.spec.ts` now reloads the folded log through
  `Session.create` — the loader-level seed validation that `foldSurface`
  replay does not cover — and asserts the surface round-trips and that no
  assistant/message is appended without settlement fields.
- **Docs**: "summary pair" wording replaced by "checkpoint" across README
  (EN/zh), design (EN/zh) and integration notes.

## v1.3.2 — 2026-09-10

**0.1.5 assistant/message nodes are immutable; install-based mounting
reverted.**

- **Fixed**: on 0.1.5 `assertProvenance` rejects `sourceEventSeqs` on
  `assistant/message` ("embeds its source stream") while the same validator
  requires every shadowed node to be cited — so assistant nodes can never be
  replaced there. The light pass now learns this from the host's first
  rejection and skips assistant nodes, continuing to dehydrate user/tool
  nodes; the heavy fold is unaffected (it replaces a `user/message` with the
  full citation list).
  Documented consequence: on 0.1.5 the light pass no longer trims reasoning /
  tool-call arguments (they live on assistant nodes); per-window savings
  there come from tool results, injections and the heavy fold.
- **Reverted**: install-based mounting (`npm pack` + unpack) — it broke
  instance startup (`request for '@deepseek-ai/cosmokit' is from a module not
  been linked`: the cordis loader refuses modules it has not linked, and a
  bare unpack is not a registered profile dependency tree). The symlink mount
  stays; v1.3.1's write-path self-correction is what makes the resulting
  module shadowing harmless. `scripts/install-local.sh` now warns about this.
- **Tests**: `crossversion.spec.ts` now seeds assistant nodes with 0.1.5's
  embedded `stream` and `model` source, asserting that the host rejection is
  learned, assistant nodes stay intact, user/tool nodes are still dehydrated,
  and 0.1.5 `foldSurface` re-accepts the log.

## v1.3.1 — 2026-09-10

**Follow-up to v1.3.0: the capability probe alone was not enough.**

- **Fixed (write path)**: when the module's own dev tree shadows the host's
  `@deepseek-ai/dsh-session`, the probe validated against the wrong
  implementation and chose the wrong spelling — 0.1.5 hosts still rejected
  every replacement. `appendReplacement()` now treats the host's
  `invalid replace surfaceOp` as authoritative, flips the spelling (cached
  per process) and retries once; a rejected append leaves no event behind.
- **Fixed (read path)**: range-fold detection used `op.start !== op.end`,
  which reads `undefined` on 0.1.5 and silently skipped round-counter
  invalidation after a fold. Now reads either spelling
  (`opStartOf` / `opEndOf`, exported for tests).
- **Changed (mounting)**: mount by installing — `npm pack` the repo (no
  `node_modules` in the tarball) and unpack into
  `profiles/node_modules/mosaic-memory-compress` — instead of symlinking a
  dev checkout. The dist then resolves the host's own session API from the
  profile and the probe is right on the first try. Applied to the production
  profile and the 0.1.5 test instance.
- **Tests**: new `crossversion.spec.ts` reproduces the shadowed-deployment
  path (dev-tree 0.1.0 module + 0.1.5 host session) and asserts the flip,
  the written op keys `[op,startSeq,endSeq]`, and that 0.1.5 `foldSurface`
  re-accepts the compressed log.

## v1.3.0 — 2026-09-10

**DSH 0.1.5 compatibility (breaking host change).**

- **Fixed**: DSH 0.1.5 renamed the `replace` surfaceOp fields
  (`{start,end}` → `{startSeq,endSeq}`, exactly three keys enforced). Our
  adapter emitted the old names, so every light/heavy replacement was
  rejected once compression actually fired — silent under default thresholds,
  fatal for the compression path on 0.1.5 hosts.
  The adapter now probes the host at runtime (replays a minimal append+replace
  log through the exported pure `foldSurface`) and emits whichever spelling
  the host accepts, caching the result and falling back to the legacy
  spelling when the probe cannot run. No version string is parsed.
- **Changed**: `dsh-module` version `0.1.0` → `0.2.0`.
- **Changed**: diagnostics are opt-in via `MOSAIC_DIAG=<path>` (previously an
  unconditional `/tmp/mosaic-diag.log` write).
- **Docs**: README DSH compatibility matrix (0.1.0 / 0.1.2 / 0.1.5+);
  INTEGRATION-NOTES §18 (root cause, probe design, verification).
- **Verified**: probe selects `legacy` on 0.1.0-rc.6 and `seq` on 0.1.5-rc.1
  (Zero runtime + profiles runtime); light and heavy passes exercised on the
  0.1.5 test instance (port 3099) with aggressive thresholds; session loads
  cleanly afterwards.

## v1.2.0 — 2026-09-05

- **Added**: `sessionDenylist` (deny always wins over the allowlist) —
  fleet-wide rollout (`allowlist: ['*']`) while keeping reference
  conversations unmanaged; per-session trigger state so one conversation
  cannot gate another.
- **Changed**: light and heavy cadences decoupled; `heavyStart` default
  30 → 40 with `lightStart=10`, making the light zone exactly one window
  wide (every batch entering the heavy zone arrives dewatered). Light first
  runs at R=40, heavy at R=70, aligned at 70/100/130.

## v1.1.0 — 2026-08-26

- **Finalized** the 10/30/30/30 configuration on a 165-round rolling
  simulation; heavy LLM cost measured negligible (~$0.06/run).
- **Added**: `sessionAllowlist` safety gate (default `[]` compresses
  nothing until explicitly enabled).
- **Added**: DSH installable bundle (`dsh.bundle` manifest, committed dist),
  listed on Awesome DSH Plugin (PR #3459).

## v1.0.0 — 2026-08-23

- Initial public release: forgetting-curve in-place compression
  (raw / light / heavy zones), zero-LLM light pass, MIT licensed.
