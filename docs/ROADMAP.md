# MosaicMemoryCompress — Roadmap

> Last updated: 2026-08-17.

## Strategic Direction

MosaicMemoryCompress stays a small, focused library: message-level forgetting-curve
compression. DeepSeek Harness is the primary integration reference, but the
library remains host-agnostic.

## Milestone 1 — Context-Aware Adaptive Thresholds (next)

**Problem**: `lightStart` / `heavyStart` / `lightWindow` / `heavyWindow`
currently default to fixed heuristics (30 / 50 / 10 / 10) hand-tuned for a
typical mid-size context window. Real models expose very different context
budgets (128K / 256K / 1M), so the right thresholds depend on the model in
use and on how much of the window the current conversation occupies.

**Primary target**: DeepSeek V4's 1M-token context window — zone boundaries
should scale with the model's context size and observed usage ratio, so the
same library behaves sensibly from 128K-class models up to 1M-class ones.

**Direction**:
- Accept an optional token/usage signal from the host (e.g. current context
  usage ratio, or a token counter), and derive zone boundaries from it —
  e.g. raw zone ≈ fixed share of the window, light zone ≈ next share, heavy
  summary ≈ bounded budget.
- Keep the anti-jitter cadence (`R % window == 0`) unchanged — it is sound.
- Keep round-based distance as the default (rounds are a time proxy: older
  rounds = earlier exchanges, regardless of per-round verbosity; the
  distribution averages out over long conversations). Optionally accept a
  `distanceMetric: 'rounds' | 'tokens'` mode for hosts that want token-budget
  precision.
- Add usage statistics so thresholds can react to observed consumption.

**Dependencies**: a real-LLM benchmark (Milestone 3) that measures information
retention, because adaptive thresholds are only meaningful if we can measure
what they cost.

## Milestone 2 — On-Compress Original Payload Callback ✅ (implemented 2026-08-14)

**Problem**: compression is lossy by design; the original text must be
preservable by the HOST (database, log, or platform spill), not by this
library.

**Direction**: add an `onCompress` callback that receives the raw payload being
compressed (plus zone metadata), so hosts can archive originals and re-read
them later on demand in their own persistence layer (database, log, or
platform spill). MosaicMemoryCompress stays stateless; this is an interface for
the architecture boundary, not built-in storage.

## Milestone 3 — Real-LLM Information Retention Benchmark ✅ (implemented)

**Direction**: script a realistic long conversation (≥100 rounds) → compress →
ask the model early-fact questions → measure retention. Also measure actual
token usage (not the assumed 200/800 tokens per round) to replace the
hypothetical efficiency table with measured numbers.

## Milestone 4 — Tool-Message Semantics ✅ (implemented 2026-08-16 — structural light truncates reasoning/arguments/results while preserving tool pairing)

**Direction**: define explicit policy for messages carrying `tool_calls` /
`tool_call_id` / `reasoning_content`: skip them, strip, or compress content
while preserving pairing integrity for OpenAI-compatible downstream validation.

## M5（方向）：成本权衡点与重置时刻增强（v2 形态）

**2026-08-16 实测发现的成本模型**：持续中间压缩（Light/Heavy 就地替换）在
DeepSeek 自动前缀缓存下有一个结构性的代价——任何历史修改都使缓存前缀
断裂，压缩当次请求整段 miss（30 倍价；实测命中率 99.7% → 4.2%）。
这是一笔"每 N 轮一次的缓存断点税"，与压缩省下的 token 之间的平衡点由
窗口参数决定（N=10 时成本约 10 倍；N 越大摊薄越多）。

**价值判断**：这笔税换来的是**有界 surface + 无限永续对话**——官方
brief 模式没有税，但代价是每次重置都变成"读简报的失忆新人"。马赛克
压缩的不可替代价值（近期记忆鲜活、远古逐渐模糊、符合生物体记忆曲线）
正是在这个权衡中被保留的。

**可调项（参数化平衡）**：
- 压缩窗口 N（10 → 20/50）：税摊薄，代价是 surface 增长更快
- 三区比例（raw/light/heavy 边界）：记忆清晰度 vs 上下文压力的连续调节
- 未来：重置时刻增强形态（见下）可把税降到零

**v2 形态：重置时刻增强**（不持续压缩，只在重置时刻增强）：
1. 官方 brief 压缩把全部历史折叠成简报（既有行为）
2. 将**最近 10-20 轮**用既有结构化截断精炼（reasoning/参数/结果
   截断，user/assistant 文本成对保留）
3. 新会话注入顺序：[精炼近期轮 + brief]——近期记忆在前

v2 收益：缓存成本为零（新会话首次 miss 是既有行为）、记忆连续性优于
纯 brief、surface 有界、复用既有组件实现极简。

**状态**：持续压缩形态暂缓上线（当前默认：官方标准、成本最优）；
M2-M4 成果完整保留，M5 随时可实现。
