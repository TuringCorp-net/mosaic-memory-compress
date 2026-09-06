# DSH Integration Notes

> Deep findings from real mount verification (2026-08-16 onward). Each pitfall:
> symptom → root cause → fix. Valuable for any DSH plugin developer.

## 1. Local-path plugins must be CJS (.cjs); ESM .js silently does not load

**Symptom**: pointing a cordis.patch.yml insert entry at an ESM build artifact
(dist/index.js) produced no load evidence after restart — no error, no log, no
service registration — while a .cjs plugin (boot-restore/index.cjs) worked.

**Root cause**: the DSH cordis loader takes the CJS loading path for local
plugins; ESM artifacts are skipped or fail silently. Node 22 require(ESM) works,
but the loader path does not accept it.

**Fix**: dual-format build (tsup format: ['esm', 'cjs']), patch name points at
dist/index.cjs. Immediate effect.

**Lesson**: after touching a plugin, add runtime diagnostics before verifying —
one console.log at the plugin entry, then check the systemd journal (the only
reliable channel). lsof is not: the file handle closes once the module is loaded.

## 2. Round counting: only source.kind === 'user' is one round

**Symptom**: a loose rule (role==='user' and not tool) counted 159 rounds while
real user messages were 80.

**Root cause**: real DSH sessions inject many system messages (runtime context,
time-context, AGENTS.md — source.kind='plugin'), 1-2 per round, nearly 1:1 with
real messages in long sessions. Tool results ('tool') and official checkpoints
('plugin' + plugin:'compact') skew loose counting further.

**Fix**: isUserRound = role==='user' && source.kind==='user' — exactly matching
"one user message = one round". Exclude checkpoints with the official
isCompactCheckpointSource predicate, never by string matching.

## 3. An official checkpoint resets the surface "memory age"

**Symptom**: after an official /compact, R fell back under the threshold and
compression stopped triggering.

**Root cause**: /compact shadows all early messages; the surface keeps only the
checkpoint node plus later messages. Counting is surface-based (what the model
sees) — shadowed rounds do not count. Surface is memory; official compaction is
a memory reset.

**Conclusion**: correct semantics, not a bug. A compacted session needs to
re-accumulate rounds before triggering. Use a temporary small threshold to verify
quickly; without official compaction the behavior matches the design.

## 4. Trigger exactness: summary nodes polluted round counting

**Symptom**: after a heavy fold, the summary-pair user node was counted by
findRoundStarts and trigger points drifted (69/78/87 instead of 60/70/80).

**Fix**: internal markers `_heavy` (summary pairs) and `_distilled` (already
dehydrated) on messages. findRoundStarts skips _heavy; light only processes
non-_distilled — incremental semantics: each trigger handles only the newly
rolled-in window, never re-distills. Rolling simulation: LLM calls 1066 → 256,
triggers locked to window boundaries.

## 5. Empty/placeholder messages needed short-circuiting (historical)

**History**: in the LLM-light era (before 2026-08-16), 16/1066 light calls
returned empty (once misreported as 35%). The lightSkipThreshold (default 160)
short-circuited them. **Obsolete since the structural-truncation redesign** —
light no longer calls the LLM; short messages stay verbatim by construction.

## 6. pre-step payload receives the agent via injection

**Symptom**: the agent/pre-step waterfall payload looked like {messages, turn,
step, signal} — no agent field.

**Root cause**: the agentEvents() factory (dsh-agent) fuses the agent into the
payload ({...payload, agent}); destructuring { agent, signal } works. Official
mechanism — nothing to handle.

## 7. Verification methodology: mounting rewrites agent memory

- Before mount: export the session + three-zone snapshot + expected checklist
- After mount: journal for load diagnostics → session log for compaction events
  and surface replacements
- Shadow semantics guarantee originals stay in the log; worst case is recoverable

## 8. Other confirmed points

- patch.yml parses with js-yaml JSON_SCHEMA (+!!js expressions); insert entries
  support id/name/config; config is passed straight to the plugin
- Dependency versions: dsh-module @deepseek-ai peerDeps match the DSH runtime
  profiles/node_modules (0.1.0-rc.6); two node_modules copies of cordis stay
  compatible via global Symbol branding
- compaction-basic is officially disabled in the web-app bundle (host plane) —
  whether a preset layer mounts an official backend depends on the version

## 9. O(n²) event lookup: pre-step measured 17.7s (fixed)

**Symptom**: seconds of GUI silence before every message; journal showed
`[mosaic] pre-step R=25 no-op (17730ms)`.

**Root cause**: surfaceNodes() did a linear events.find(seq) per surface node —
an 80-round conversation produces ~38k events × 675 surface nodes = 25.6M
comparisons per pre-step.

**Fix**: Map index (O(n) build + O(1) lookup) → 17730ms → 132ms.

**Lesson**: real sessions produce ~500× events per round (tool calls, chunks,
reasoning all count) — any seq lookup must be indexed, never linear find.

## 10. Incremental round counting: O(1) no-op pre-step (2026-08-16)

**Problem**: even indexed, a full scan per pre-step is O(n) and degrades as the
session grows (100k events ≈ 400ms, 1M ≈ seconds).

**Design** (correctness closed by three rules):
- **Incremental maintenance**: listen to session/event (append-only stream) — a
  real user message (source.kind==='user') increments the counter
- **1:1 replacements do not invalidate**: light truncation (start===end) keeps
  the user source; the count is unchanged, no dirty mark
- **Range folds mark dirty**: any start!==end replacement (heavy fold, official
  checkpoint, third-party) → dirty → next pre-step recomputes fully
- **Lazy init**: first pre-step after restart scans once; the trigger path
  recomputes zones anyway and re-syncs

**Measured**: no-op 124ms (init) → 0ms (incremental); journal R reconciled
against full surface counting round by round.

## 11. pre-step diagnostic logging (verification methodology)

The module logs one journal line per compactIfNeeded:
`[mosaic] pre-step R=NN trigger=pressure no-op (Xms)` / TRIGGERED variants
(lightCalls/lightTokens/heavyFolded/elapsed). After a restart the journal is the
only reliable verification channel (lsof is not — handles close after load).

## 12. Light redesign: LLM distillation → pure structural truncation (2026-08-16)

**Data-driven decision**: real 40-round surface token composition — reasoning
33% + tool-call arguments 33% + tool results 24% + injections 4% + **text only
~5%**. LLM-distilling text was "90% of the cost against 10% of the target": 254
calls / 12s / 380k tokens for 5.6% net savings.

**New scheme (measured)**: structural truncation (reasoning head+tail 30,
arguments JSON shell with 120-char field truncation, results head 30 tail 30,
injections 30, text untouched) → 46.1% net savings, zero LLM, milliseconds.

**API safety verified against the live DeepSeek API**:
- reasoning_content truncated/removed → 200 OK, correct answers (finish=stop)
- arguments plain-text or JSON-shell truncated → 200 OK (only structure is
  validated, not content)
- tool_call_id pairing preserved → no 400

**Lesson for DSH**: surface bulk is structured content (reasoning/arguments/
results), not text — context compression should handle structured payloads first.

## 13. Mount verification (2026-08-16, structural light first trigger)

- Trigger at window boundary; 556 replacements (assistant 237 / tool-result 217 /
  user 102)
- Truncation verified: reasoning exactly 61 chars (30+30); arguments 216/217 with
  markers (JSON shell kept); tool-result 75 chars (30+30); user text zero loss
- Shadow price: 246k tokens deducted; **context usage 53% → 30%**
- LLM calls: 0 (vs LLM era: 254 calls / 380k tokens / 12.5s)
- Known: the TRIGGERED journal line was missing on the first post-restart
  trigger (systemd buffering; the event log is authoritative); distilledSeqs is
  in-memory, so one full re-truncation happens after restart (persist later if
  needed)

## 14. Cache-breakpoint cost: first model of continuous compaction (2026-08-16)
> **SUPERSEDED in its multipliers by field measurement — see §16 (2026-09-06).**
> The 2026-08-16 run was the heavyStart=30 era, single-shot fold at ~50 rounds:
> hit rate 99.7% → 4.2% measured; the "~10× session cost" / "N=10 is 10-15×"
> figures were extrapolations from that one fold, not measured steady state.
> Production numbers (light 1:1 pass and heavy fold, aligned 10/40/30/30
> config) show per-window taxes of $0.02-0.10 repaid ~2-10× within the same
> window by surface savings — see §16. Historical measurement kept for the
> mechanism description below.

**Measured (2026-08-16)**: the compression request dropped cache hit rate
99.7% → 4.2% (290k tokens missed wholesale at 30× price), recovering to
99.9% immediately after.

**Mechanism (still valid)**: DeepSeek automatic prefix caching matches from
the head; any edit of sent history moves the breakpoint forward and
everything after it misses. Two field-verified shapes (2026-09-06):
mid-surface 1:1 replacement (light) keeps the prefix up to the first
replaced node (~97% hit on the next request); head replacement (heavy fold)
breaks the whole prefix — structurally unavoidable, see §16.

**General lesson**: context-compression algorithms must put the
cache-breakpoint cost into the cost model; on automatic-prefix-cache
providers, in-place history edits need an explicit window/frequency
tradeoff, not an assumed free lunch.

## 15. Parameter finalization 10/40/30/30 + cost verification (2026-08-26, amended 2026-09-05)

**Finalized config**: lightStart=10, lightWindow=30, heavyStart=40,
heavyWindow=30 — light and heavy cadences DECOUPLED per-session, light zone
exactly one window wide (30 rounds: [R-40, R-10)) so every batch entering the
heavy zone arrives already dewatered; light first runs at R=40, heavy first
at R=70, both aligned at 70/100/130 (same pre-step, same cache miss).
Steady state: summary pair + 40 user rounds (≤41 messages per round).
(The 2026-08-26 finalization of 10/30/30/30 was superseded on 2026-09-05 by
the decoupled-cadence design above; scenario tests re-seeded 60→70.)

**Rolling simulation over a real 165-round conversation**:
- heavy folds: 4 (rounds 60/90/120/150, exactly 30-round intervals)
- cache misses: 5 (rounds 30/60/90/120/150; same-round light+heavy merges into
  one request)
- LLM calls: 4 (heavy only), each sending only the heavy zone (14-26K tokens vs
  1.37M chars total — 50× smaller)
- LLM cost: ~$0.057 for the whole run (assumed input $0.5/M + output $2/M) —
  negligible
- final: 46 user rounds / 16.6% character retention; estimated total cost
  (cache tax included) ≈ 1.8× baseline

**Key insight**: heavy LLM cost is negligible (cents); the cost driver is the
cache-miss tax (surface×30/N), and the window N is the only effective lever —
the 30-round alignment is the optimal balance.

## 16. Field cost measurement: light-pass cache tax vs surface savings (2026-09-06)

Live DSH session `85cd44e7` (coding workspace, workflow conversation, 55 real
user rounds) ran the first production light pass after the 0.1.2 API fix:

- 706 mid-surface nodes replaced 1:1 (30-round light zone dewatered);
  surface 553K → 313K tokens (context usage 55% → 39%)
- Next-request cache accounting (usage fields): cacheRead 304,512 (prefix up
  to the first replaced node still hits — 97% of the new surface),
  miss 79,986 tokens (vs 221 baseline) → **one-time light tax ≈ 79.8K tokens,
  ≈ $0.015–0.04**
- Payback: each of the following ~30 requests bills ~240K fewer surface
  tokens ≈ $0.20 per window → **≈ 10× the tax** — the dewatered surface
  repays the cache break within a few rounds

This refines §15's simulated ~1.8× baseline: that number modeled a
single-shot full-surface miss (heavyStart=30 era). Under the aligned
10/40/30/30 design the light pass breaks only the replaced span (not the
prefix), and the heavy fold consumes an already-dewatered zone — steady-state
cost sits well below 1.8×, dominated by the surface the raw zone keeps vivid.

(Measurement caveat: prefix hit up to the replacement point means the light
zone's position in the surface matters — earlier light zones break more
prefix. Zone positions are age-relative, so the break stays bounded by the
40-round steady state.)

## 17. Field cost measurement: heavy fold (2026-09-06, same session, R≥70)

First production heavy fold after the 0.1.2 fix — surface head replacement,
1000 nodes / 247,829 tokens → 7,672-char memory node (~10s LLM stall):

- Next-request cache accounting: cacheRead 490,752 → 2,688 (99.9% → 1.6%
  hit); miss 193 → 165,287 tokens → fold tax ≈ $0.046
- Fold LLM call: not metered in the event stream (no usage on
  compaction/summary) — estimated ≈ $0.05 for the pre-dewatered ~100-250K
  input
- Surface 491K → 168K (−66%; context usage 49% → ~25%); second request
  after the fold already back at 99.6% hits
- 30-window ledger: fold tax + LLM ≈ $0.10 one-time; each following request
  bills ~322K fewer surface tokens ≈ $0.009/round → ≈ $0.27/window →
  **net ≈ +$0.15-0.17 per window — steady-state cost goes DOWN, no 2× regime**

**Structural**: requests are time-ordered (oldest first) and the fold target
is by definition the head — prefix caches match from token 0, so a head fold
cannot keep any prefix (three constraints: time order / oldest-first
compression / prefix-from-head). Head tax is unavoidable; bounded by keeping
the fold input pre-dewatered. Newest-first layout would break the prefix on
every message instead — no free layout exists.
