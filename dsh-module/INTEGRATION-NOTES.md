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
Steady state: one checkpoint message + 40 user rounds (≤41 messages per round).
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

## 18. DSH 0.1.5 compatibility: replace surfaceOp field rename (2026-09-10)

**Symptom** (only once compression actually fires — default thresholds keep
the engine on the no-op path, so this stays silent until a session reaches
R≥40): `EXCEPTION: session event "user/message" carries an invalid replace
surfaceOp`.

**Root cause** (0.1.5 `packages/core/session/src/surface.ts`):
`isReplaceOp` requires exactly three keys `{op:'replace', startSeq, endSeq}`;
0.1.0/0.1.2 required `{op:'replace', start, end}`. The key-count check is
exact, so writing both spellings is rejected too. Our module emitted the old
names → V3 validation refused every replacement.

**Fix** — behavioural capability probe, not version parsing: replay a minimal
two-event log (append + replace with the new field names) through the pure
`foldSurface` export. 0.1.5+ folds it; 0.1.0/0.1.2 throw "invalid replace
surfaceOp". Result is cached per process; an unrunnable probe falls back to
the legacy spelling. `replaceOp(start, end)` then emits the spelling the host
accepts (exactly three keys either way).

**Verified** (2026-09-10): probe selects `legacy` on 0.1.0-rc.6 (dev tree) and
`seq` on 0.1.5-rc.1 (both the Zero runtime and the profiles runtime); light and
heavy passes exercised on the 0.1.5 test instance (3099) with aggressive
thresholds (lightStart=1/W1/heavyStart=2/W1), session still loads cleanly.

**Also in this change**: diagnostics moved behind `MOSAIC_DIAG=<path>` (was an
unconditional /tmp write, added 2026-09-05 for the journald-buffering hunt);
dsh-module version → 0.2.0.

**Follow-up — the probe alone was not enough (same day).** With the module
mounted by symlinking the *dev checkout* into `profiles/node_modules`, the
dist's own `dsh-module/node_modules/@deepseek-ai/dsh-session` (0.1.0-rc.6, a
dev dependency) shadows the host's: `import` resolves to the dev copy, so the
probe validated against 0.1.0's rules and chose `legacy` while the 0.1.5 host
rejected it. Two fixes, both applied:

1. **Write-side self-correction (authoritative)**: `appendReplacement()`
   catches `invalid replace surfaceOp`, flips the spelling (cached per
   process), and retries once. A rejected append leaves no event, so the retry
   is safe. Module resolution can no longer decide correctness — the host's
   own validation does. Reproduced and verified by mounting the dev checkout
   (shadowed) against a 0.1.5 session: probe logs `legacy`, first append is
   rejected, correction flips to `seq`, light + heavy both land, and 0.1.5's
   `foldSurface` re-accepts the compressed log.
2. **Mounting: keep the symlink.** Installing (`npm pack` + unpack into
   `profiles/node_modules/mosaic-memory-compress`) does make the probe
   resolve the host's own session API and select `seq` on the first try —
   but it breaks instance startup: the cordis loader refuses modules it has
   not linked (`request for '@deepseek-ai/cosmokit' is from a module not been
   linked`), because a bare unpack is not registered as a profile dependency
   tree (profiles/ has no package.json). Reverted in production; the symlink
   stays, and fix (1) — host validation as the authority — is what makes the
   shadowing harmless. If an install-based mount is ever wanted, register the
   package as a real profile dependency first.

**0.1.5 follow-up 2 — assistant/message nodes are immutable on 0.1.5.**
`assertProvenance` throws `assistant/message embeds its source stream and
cannot carry sourceEventSeqs` while the same function requires every shadowed
node to be cited — so on 0.1.5 an assistant node can never be replaced. The
light pass now learns this from the host's first rejection (`assistantImmutable`)
and skips assistant nodes, continuing to dehydrate user/tool nodes; the heavy
fold is unaffected (it replaces a user/message with the full citation list).
Consequence documented: on 0.1.5 the light pass no longer trims reasoning /
tool-call arguments (they live on assistant nodes), so per-window surface
savings there come from tool results, injections and the heavy fold.

**0.1.5 follow-up 3 — assistant settlement fields vs the session loader.**
The fold used to append a second `assistant/message` ("ancient rounds folded
…"). 0.1.5 requires every assistant event to carry settlement fields
(`turn`, `step`, and an embedded `stream` array — the same fact behind "embeds
its source stream"); without `stream` the *loader* reports the stored session
as corrupt (`SessionQueryError: … seed assistant/message … has invalid
settlement fields`) — the session stops loading. The fold now writes exactly
ONE `user/message` checkpoint, matching the official backend, and the notice
rides in that message's text.

**Methodology lesson (from the same report)**: `foldSurface` replay does NOT
exercise the loader's seed-envelope validation, so that class of defect slips
through a replay-only test. `crossversion.spec.ts` now also reloads the folded
log with `Session.create` (the loader-level validation path) and asserts the
same surface comes back, plus that no assistant/message is appended without
settlement fields.

**Read-side companion fix**: the `session/event` listener detected range folds
via `op.start !== op.end`; on 0.1.5 those keys are `undefined`, so a fold
never invalidated the per-session round counter. Now `opStartOf(op) !==
opEndOf(op)` reads either spelling.

**Lesson**: the 0.1.2 event-name change (session.events → snapshotEvents) and
this 0.1.5 field rename are the same class of breakage — host API drift that
stays invisible until a compressing path runs. Probe capabilities at runtime,
keep the legacy path as the fallback, AND make the write path self-correcting:
a probe can only be as right as the module resolution it runs under, so let
the host's validation be the final word. Also: never mount a dev checkout by
symlink when it carries its own dependency tree.

## 19. Stored-session upgrade hazard: pre-v1.3.2 assistant replacements are refused by the 0.1.5 migration (2026-09-10)

**Symptom** (found while upgrading a long-lived 0.1.2 host to 0.1.5-rc.1).
Conversations that mosaic had compressed on the old host stop opening:

```
assistant/message <seq> chunk provenance is not one complete ordered attempt;
source v0 artifact remains unchanged
```

The migration refuses *before* writing, so the stored log is untouched and the
data is intact — the conversation is simply unloadable.

**Root cause.** 0.1.5 reads a stored v0/v1 log through the released
`v0→v1→v2→v3` chain. In `session-format-v1-to-v2/src/migration.ts`
`transformMessage()` (tag `dsh-v0.1.5-rc.1`, lines 265–301) an
`assistant/message` carrying a **non-empty** `sourceEventSeqs` must match the
currently pending chunk attempt group; a missing pending group (or a mismatch)
is exactly the refusal above. Before v1.3.2 the light pass replaced assistant
nodes 1:1 with events citing only the replaced seq
(`surfaceOp={op:'replace',start:X,end:X}`, `sourceEventSeqs=[X]`, no `stream`)
— and those copies are appended long after the attempt closed, so no pending
group exists. The rules are not literally irreconcilable (`sourceEventSeqs: []`
takes a separate passing branch), but the citation a 1:1 replacement *wants*
cannot be expressed in v1's chunk-attempt provenance model.

**Invariants measured on the refused logs** (worth keeping; trial-and-error hit
each of them):

- `seq` in v0/v1 is a **logical chunk-space counter, not a row number**: one
  log had 78,785 rows, 26,190 seq-bearing events and `max seq = 1,356,342`
  (first event `seq: 0`); packed `reasoning-chunks` / `tool-call-chunks` /
  `text-chunks` rows carry no `seq` and point back with `seq0`.
- Consequence: deleting mosaic events and renumbering rows is not a repair —
  it breaks the counter (`row N has seq gap`). v1→v2 later renumbers to dense
  event indices, so nothing may assume row numbers upstream either.
- v2→v3 additionally requires positive `step`; the heavy fold's companion
  event wrote `step=0` (removed structurally in v1.3.3).

**Repair decision: none.** Ten-plus in-place rewrites were attempted (delete +
renumber, retype the events to official `compaction/prune`, …) and each failed
on a different invariant (`row N has seq gap`, `shadowedSeqs do not name an
exact current surface span` at `session-format-v0-to-v1/src/relationships.ts`
line 495, …). The transcripts were exported instead; `scripts/salvage-session.py`
does that generically and read-only.

**Blast radius.** Only logs containing *assistant-level* mosaic replacements are
refused; `user/message` and `tool/result` replacements do not enter that rule.
On the affected host, 2 of 156 stored logs contained assistant replacements
(565 and 1,182 events); 9 more contained user/tool replacements only. Detector
(read-only):

```bash
zstdcat session.jsonl.zstd | grep -c '"surfaceOp":{"op":"replace"'
```

**Positive control, from the storage layout.** A successful 0.1.5 load writes a
migrated `session.v3.jsonl.zstd` next to the original `.jsonl.zstd` (a
0.1.5-era session may have only the v3 file). On the affected host 11 logs had
a v3 file — including 4 of the 9 user/tool-only logs, which is direct proof
they migrate cleanly — while **neither** refused log had one. "Has
`session.v3.jsonl.zstd`" is therefore the cheap load-probe when auditing a host
that has been upgraded:

```bash
find sessions -name 'session.v3.jsonl.zstd'
```

**Prevention / what to tell users.** v1.3.2+ never writes assistant
replacements on 0.1.5 (it learns `assistantImmutable` from the host's first
rejection) and v1.3.3 folds into a single `user/message` checkpoint, so
sessions written from then on are migration-safe on those hosts. On hosts
≤0.1.2 the light pass still replaces assistant nodes — that is what seeds this
hazard for a future upgrade. Upgrade path: mount mosaic v1.3.2+ **before**
upgrading DSH, and treat any conversation compressed on ≤0.1.2 as salvage-only
across the 0.1.5 boundary.

## 20. The `dsh plugin add` install path: the CJS entry cannot import the host (2026-09-10)

**Symptom.** Installing the package the way a user would —
`dsh plugin --profile web add mosaic-memory-compress` (registry) or
`… add github:TuringCorp-net/mosaic-memory-compress` — then booting, kills the
whole instance:

```
dsh: plugin tree failed to load: … failed to import loader entry
mosaic-memory-compact (mosaic-memory-compress/dsh-module/dist/index.cjs):
request for '@deepseek-ai/cosmokit' is from a module not been linked
```

**Why the checkout mount never showed it.** Production mounts this repo by
symlink, so the dist's `require('@deepseek-ai/cordis')` resolves the repo's own
nested dev copy. A pnpm install has no nested copy: the request resolves to the
host's *already asynchronously loaded* ESM file, and Node's `require(esm)` sync
path cannot link it (`ERR_VM_MODULE_LINK_FAILURE`). A/B on clean DSH_HOMEs, all
booted with the same CLI: no plugin → boots; third-party plugin (`dshmarket`,
installed the same way) → boots; this package with the CJS entry → dies.

**Fix.** The bundle patch loads the ESM build `dsh-module/dist/index.js`
(exported from `package.json` alongside the `.cjs`). Verified end-to-end on a
clean `DSH_HOME`: `dsh plugin add <tarball>` → boot OK →
`[mosaic-memory-compact] engine constructed (lightStart=10, heavyStart=40)`.
The `.cjs` subpath stays for the symlink mount. Note that the bundle patch's
`heavyStart` was also out of sync with the docs (30 vs 40) — corrected.

**Lesson (same family as §18/§19).** "It runs on my machine" does not prove
"it installs". Exercise the path a user actually takes — `dsh plugin add` into a
clean `DSH_HOME` — not only the developer mount; the mount hides module
resolution behind its own nested `node_modules`.

## 21. From DSH 0.1.5 on, mount the built-in compaction — not this adapter (2026-09-12)

**Conclusion.** Code-level review of `dsh-v0.1.5-rc.1` shows the official
`compaction-basic` backend already implements the *core* of what this adapter
was built for — a verbatim recent window plus one bounded checkpoint for
everything older, on a pressure trigger that never interrupts the conversation,
plus overflow recovery this adapter never had — with a far stronger safety
story (durable lock, `compaction/start|summary|end` transaction, replay
stability re-validation, shrink check, KV-cache-reusing summarization call).
Only the Light zone (zero-LLM, age-based structural dehydration) has no
official equivalent. That single remaining feature does not justify shipping
and version-tracking a second compaction engine. **On any host at 0.1.5 or
newer: use the built-in compaction and do not mount this adapter.** The adapter
stays supported for ≤ 0.1.2 hosts; the framework-agnostic library is unaffected.

### 21.1 What the official backend does (0.1.5 code coordinates)

| Behavior | Implementation |
|---|---|
| Trigger | `agent/pre-step` → `compactIfNeeded(agent, 'pressure')`, every step (`compaction-basic/src/index.ts:148-166, 294-332`) |
| When | `measurement.totalTokens ≥ floor(contextWindow × thresholdRatio)`, default ratio **0.8** (`config.ts:20, 144`) |
| Pressure unit | the token meter's `totalTokens`, whose baseline is the **provider-reported usage of the last successful call** when its envelope matches, else an estimate — i.e. real request size, not a heuristic (`dsh-token-meter/lib/index.js` `measure()`) |
| Kept verbatim | the recent tail, accumulated newest→oldest until `retainTokens` route-priced tokens are covered; default `retainRatio` **0.16** (`region.ts:116-154`, `config.ts:22-23, 145-147`) |
| Folded | everything from the first non-`system/message` surface node up to that tail — **as one** checkpoint node (`region.ts:130-153`) |
| Manual `/compact` | `compactNow()` with `retainTokens = 0` → keeps only the last balanced step (`index.ts:369-421`) |
| Overflow recovery | provider-confirmed `CONTEXT_WINDOW_EXCEEDED` bypasses threshold and retention, prunes, folds, retries (`index.ts:180-224, 284-292`) |
| Summarizer input | full-fidelity replay: system head + header tools + the region's own messages, then the 8-section compaction instruction — deliberately a genuine prefix of the last request so the provider's KV cache is reused (`region.ts:528-546`, `summarizer.ts:24-70`) |
| Guards | durable lock; whole-surface (auto) / selected-span (manual) re-validation; the framed summary must price **below** the shadowed span; `compactionRetries` default 1 (`region.ts:172-274, 399-412`) |
| Model-free pre-pass | `tool-result-pruner`: tool results over 8192 chars → head 4096 + marker + tail 1024, only after a trigger qualifies (`compaction-tool-result-pruner/src/index.ts:83-122`) |

On this deployment (`llm-deepseek` declares `contextWindow: 1e6` for
`deepseek-flash`) that resolves to: **compact at ~800k tokens, keep the newest
~160k tokens verbatim.** Field check: the 2026-09-10 fold in the Workflow
session folded 1,078 nodes / 535,851 tokens on a call whose
`usage.inputTokens` was 738,636 — 535k folded + ~160k retained + tools/system,
which matches the model.

### 21.2 Side by side

| | Official (auto) | This adapter |
|---|---|---|
| Near window | newest `0.16 × window` **tokens** (content-adaptive) | newest `lightStart` **rounds** (content-agnostic, default 10) |
| Middle | **none** — nothing is touched before the threshold | Light zone: 1:1 replacements, zero-LLM structural truncation (reasoning head/tail 30, tool-call string fields ≤120, tool-result text head/tail 50) |
| Far | one checkpoint, same cut as the middle | Heavy zone: one checkpoint, text-only summarizer input |
| Shape | a **cliff** at 80% of the window | a **gradient** from round 10 onward |
| Summarizer input | lossless replay (tools, results, reasoning), KV-cache reuse | user/assistant text only |
| Interruption | never; overflow triggers recovery + retry | heavy fold can fail soft |
| Safety | lock + transaction + stability + shrink checks | reuses the same transaction for the heavy fold only |

### 21.3 The one thing official does not do

Age-based, zero-LLM dehydration. The official pruner is the closest analogue but
it only runs *after* a trigger qualifies, only touches tool results, and keeps
4096/1024 chars rather than 50/50. So a session below 800k tokens carries every
reasoning block, tool argument and tool result in full — the adapter's Light
pass is a genuine saving there. Whether that is worth a second engine is a
product call, and on a 1M-window host the answer is no: the same effect is
reachable from official configuration alone (below).

### 21.4 Getting mosaic-like behavior from official configuration

The full policy surface is `thresholdRatio`, `retainRatio` (xor `retainTokens`),
`summarizationProvider`/`summarizationModel`, `maxTokens`, `compactionRetries`,
`maxOverflowRetries`, `modelPolicies` (exact `{provider, model, ...partial}`
overrides) and `auto` (`compaction-basic/README.md`, "Tuning when condensation
starts"). Constraints: `retainRatio < thresholdRatio`; an absolute
`retainTokens` must stay below the resolved threshold; the two retention forms
are mutually exclusive.

Two traps worth knowing:

- **Absolute thresholds are not a field.** The trigger is always
  `floor(routedContextWindow × thresholdRatio)`. Reach an absolute token budget
  by arithmetic (`0.15` for 150k on a 1M window) or by changing the window the
  adapter declares — `defaultContextWindow` / a catalog model's `contextWindow`
  — which is a host-plane row and can be set in `$DSH_HOME/settings.yaml` under
  `llm-deepseek:`, hot-reloaded, no restart.
- **A misconfiguration fails silently.** `retainRatio ≥ thresholdRatio` is
  rejected at load, but `retainTokens ≥ thresholdTokens` throws
  `TargetPressureConfigError` when the model is first used; the automatic
  listener warns **once** and then proceeds with full history — automatic
  compaction stops happening with no visible error. Always read the boot log
  after changing these numbers.

### 21.5 A structural change that matters for any compaction plugin

0.1.5 moved `compaction-basic`, `command-compact` and `tool-result-pruner` out
of the host plane and into each agent preset's own realm: the web bundle
disables the host rows (`dsh-web-app/cordis.patch.yml:420-437`) and every
preset re-mounts them inside `cordis:group` with
`isolate: {compaction: true, toolResultPruner: true}`
(`dsh-agent-presets/presets/{standard,ptc,cordis}/agent.cordis.yml`); only the
`tokenMeter` deliberately stays host-plane. Consequences:

- A plugin mounted from a profile patch lives in the **root realm**, so it is
  *not* `ctx.compaction` for any preset-composed session; `/compact` resolves
  the preset's own engine. The adapter degenerated into an extra `agent/pre-step`
  listener — which is exactly the two-engines-in-one-session behavior recorded
  in §"production reality" of the project MEMORY.
- To own compaction, a plugin must be mounted **inside the preset's compaction
  group**. Also note the roster prepends the shipped root and it wins duplicate
  ids, so a user preset cannot shadow `standard`/`cordis`; it needs a new id and
  a default change (`agent-presets.default` in `$DSH_HOME/settings.yaml`).
- A host-plane engine would also collide if the host rows were ever re-enabled
  in the root realm (two `ctx.compaction` registrations).

### 21.6 How this was verified

Read-only source study of the installed `0.1.5-rc.1` packages and of the
`dsh-v0.1.5-rc.1` tag in `coding/Reference/deepseek-harness`, cross-checked
against production evidence (the Workflow session's two folds, the token
accounting above, and the interleaved journal lines showing both engines
running). No production behavior was changed to reach this conclusion.