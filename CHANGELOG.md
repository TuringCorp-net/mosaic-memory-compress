# Changelog

All notable changes to MosaicMemoryCompress and its DSH adapter.
Dates are local (Asia/Shanghai).

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
