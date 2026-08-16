# MosaicCompress 集成 DeepSeek Harness — 系统设计（中文版）

> MosaicCompress 以纯插件后端的形式，把自然遗忘曲线压缩带进 DeepSeek Harness
> (DSH)——**对 DSH 源码零改动**。
> English version: DESIGN.md
> 集成踩坑实录（真实挂载验证经验）：INTEGRATION-NOTES.md

## 一、概述

三个分区，按对话表面计算：

- **Raw 区（最近 N 轮，默认 30）**——原样保留，零开销
- **Light 区（随后 M 轮，默认 20）**——逐条消息蒸馏，消息数不变
- **Heavy 区（更早轮次）**——折叠为单个永不超上限的 checkpoint（增量式摘要之摘要）

## 二、工作原理

DSH 的对话就是一块表面数组（surface：user/assistant/tool 消息，模型可见顺序）。
引擎挂在官方 pre-step 事件上：

```
每次 agent 步前 → compactIfNeeded(agent, trigger, signal)
  │
  ├─ count = 表面上的"真人用户轮数"
  │         （工具结果消息虽然 role:'user' 但 source.kind==='tool'，
  │           不算记忆轮；只有真正的用户回合才算）
  │
  ├─ 未达阈值 或 不在窗口边界 → return null（零成本，什么都不做）
  │
  ├─ LIGHT 通道 — 对中间区（heavyStart..lightStart 轮）逐节点替换：
  │     每节点：一次 LLM 蒸馏调用（并发执行）
  │     session.append(同角色, 蒸馏后内容, {
  │       surfaceOp: { op: 'replace', start: seq, end: seq },  // 1:1 替换
  │       sourceEventSeqs: [seq],
  │     })
  │     → 数量不变；原始节点进 shadow（仍在日志中，可查询）
  │
  └─ HEAVY 通道 — 官方 compactRegion() 事务折叠古早区：
       一个 checkpoint 节点替换 heavyStart 以前所有节点
```

**位置即年龄**：分区只按表面位置计算（从尾部数用户轮），不追踪轮次账本。
纯函数在 `src/zones.ts`（`zoneBoundaries(userCount, lightStart, heavyStart)`）。

## 三、核心机制

### 3.1 Light：纯结构化截断

2026-08-16 起 light 为**零 LLM 调用的结构化截断**，依据真实 surface 的
token 构成实测（reasoning 33% + 工具参数 33% + 工具结果 24%，文本仅 ~5%；
截断净省 ~46%，而 254 次 LLM 调用只省 5.6%）：

- reasoning 块：头尾各 30 字符（字段保留——DeepSeek 会回放它）
- 工具参数 arguments：保留 JSON 壳，字符串字段截断到 120
- 工具结果块：内部文本头 30 + 尾 30
- 系统注入：截断到 30
- 用户/助手文本：不动（留给 Heavy 折叠）

同步、确定、永不失败；shadow-price（compaction/prune）上报不变。

### 3.2 Heavy：有界 checkpoint，我们的摘要

heavy checkpoint 由**我们**的摘要生成，不是 DSH 的：

- 重写 `summarize()`：采用主库的对话记忆压缩器指令——规定角色与输出形态，
  但内容取舍交给模型自己决定（关键决策、偏好、未完成事项、教训；古早冗余
  可省略）。
- `maxTokens`（默认 8192）硬上限——永不超限，构造保证。
- 增量：上一轮 checkpoint 在 heavy 范围内，会被再次概括（摘要之摘要）。

`compactRegion()` 本身就是"一段 → 一个摘要节点"，带完整事务（锁、
compaction/start|end 标记、稳定性检查、checkpoint 框架）。本模块复用事务，
只替换摘要内容。

### 3.3 替换 API

对话是一个消息数组，一次 append 调用替换其中**一个元素**：

```ts
session.append('user/message', 新消息, {
  surfaceOp: { op: 'replace', start: seq, end: seq },  // start === end → 单节点
  sourceEventSeqs: [seq],
})
```

- 新内容进入模型可见数组的该位置；
- 原始内容留在会话日志里被 shadow——永不删除，可查询；
- 三种角色都可替换（user/assistant/tool-result），替换后角色与工具配对
  （`toolCallId`）不变。

### 3.4 防抖窗口：计数器决定

```ts
count = 表面上的真人用户轮数   // 增量维护，O(1) 读取
if (count < lightStart) return null          // 未达阈值
if (count % lightWindow !== 0) return null   // 不在窗口边界（防抖）
```

计数由会话事件流**增量维护**（监听 session/event，append-only）：
真实用户消息（source.kind==='user'）进入即 +1；light 的 1:1 替换不改计数；
任何范围折叠（heavy checkpoint 等）标记失效、下次使用时全量对账。
新会话/重启后首次使用时全量初始化一次。因此 no-op 路径恒定 O(1)，
与对话长度无关，且计数永远与 surface 真实状态一致。

`lightWindow`（默认 10）是防抖窗口：只在窗口边界压缩。`context-overflow`
可绕过窗口强制触发。返回 `null` = 本次什么都不做（零成本路径）。

## 四、用到的 DSH 扩展点

- **CompactionEngine seam**：`MosaicCompactionEngine extends BasicCompactionEngine`，
  重写 `compactIfNeeded`（触发 + 分区通道）与 `summarize`（heavy 指令）。
  官方事务机制原样复用。
- **`session.append` + `surfaceOp: replace`**：Light 的关键使能器
  （逐节点 1:1 替换）。公开、已验证 API——官方 checkpoint 自己就用它。

## 五、配置

```yaml
# cordis.patch.yml（web profile 覆盖）
- id: compaction-basic
  disabled: true          # 同一时刻只有一个 ctx.compaction 后端

- id: mosaic-compact
  name: '@turingcorp/dsh-mosaic-compress'
  config:
    lightStart: 30
    lightWindow: 10
    heavyStart: 50
    heavyWindow: 10
    lightMaxTokens: 1024
    maxTokens: 8192
```

## 六、架构边界

- **原始内容永不删除**——替换只是 shadow，可查询。
- **checkpoint 节点 = heavy 摘要**，受 `maxTokens` 约束。
- **Light 逐条**（每消息一次 LLM 调用、纯文本、并发）——绝不批量；失败保留原文。
- `compaction/start|end` 标记 = 宿主的持久记录。

## 七、测试

测试直接对真实 @deepseek-ai 包运行（无任何 mock 声明）：

| 套件 | 覆盖 |
|---|---|
| zones.spec | 分区边界数学，含边界相等情形 |
| smoke.spec | 真实 Session 上单节点表面替换 |
| pipe.spec | 阈值/窗口外零成本；完整 60 轮流水线（light 蒸馏、raw 原文、heavy 折叠 60 → 51 节点）；LLM 失败保留原文 |

## 八、范围外

- 多级颗粒度金字塔：理论在设计文档；刻意不实现（工程选择）。
- MCP 服务形态：可能的未来。
- 修改 DSH 源码：本模块刻意零改动。
