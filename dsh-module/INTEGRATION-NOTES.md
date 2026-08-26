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

## 14. Cache-breakpoint cost: the cost model of continuous compaction (2026-08-16)

**Measured**: the compression request dropped cache hit rate 99.7% → 4.2%
(290k tokens missed wholesale at 30× price), recovering to 99.9% immediately
after. Session cost was ~10× a non-compressed session.

**Mechanism**: DeepSeek automatic prefix caching matches from the head; any edit
of sent history moves the breakpoint forward and everything after it misses
(the raw zone is affected too — matching is continuous, not per-zone).

**Cost model (tunable)**: the tax ≈ surface×30/N per round amortized. N=10 is
~10-15× the no-compression incremental tax; larger N (20/50/100) amortizes
linearly. The balance point is set by cost sensitivity vs the need for unbounded
dialogue — parameterized, not a structural dead end.

**Value comparison**: the tax buys bounded surface + unbounded dialogue; the
official brief mode has zero tax but every reset makes the model a stranger.
The core value (fresh recent memory + progressively fuzzier ancient memory —
the biological forgetting curve) survives the tradeoff.

**v2 direction**: reset-moment enhancement (ROADMAP M5) — inject refined recent
rounds at new-session/brief moments; zero cache cost; philosophy preserved.

**General lesson**: context-compression algorithms must put the cache-breakpoint
cost into the cost model; on automatic-prefix-cache providers, in-place history
edits need an explicit window/frequency tradeoff, not an assumed free lunch.

## 15. Parameter finalization 10/30/30/30 + cost verification (2026-08-26)

**Finalized config**: lightStart=10, lightWindow=30, heavyStart=30, heavyWindow=30
(three-tier memory: 10 vivid rounds + 20 dehydrating rounds + fold before round
30; light/heavy windows strictly aligned so every cache miss does truncation
and fold in one request).

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