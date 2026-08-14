# MosaicCompress 集成 DeepSeek Harness — 系统设计（中文版）

> 状态：**原型已实现并通过测试**（源码 456 行；typecheck + 三套测试全部通过，
> 直接对真实 @deepseek-ai 0.1.0-rc.6 包验证，无任何 mock 声明）
> 英文原版：DESIGN.md（本文与之对应，中文优先更新）

## 一、目的

把 V1 马赛克语义带进 DSH 会话：

- **近 30 轮（raw 区）**：原样保留，零开销
- **30-50 轮（light 区）**：逐条消息脱水——**消息数不变**
- **50 轮以前（heavy 区）**：古早区折叠成**单个有界 checkpoint，永不超上限**
  （增量式"摘要的摘要"）

## 二、数据流（怎么工作的）

DSH 的对话就是一块**表面数组**（surface：user/assistant/tool 消息，模型可见顺序）。
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
  │     每节点：LLM 逐条蒸馏（或 rules 模式零成本）
  │     session.append(同角色, 蒸馏后内容, {
  │       surfaceOp: { op: 'replace', start: seq, end: seq },  // 1:1 替换
  │       sourceEventSeqs: [seq],
  │     })
  │     → 数量不变；原始节点进 shadow（仍在日志中，可查询）
  │
  └─ HEAVY 通道 — 官方 compactRegion() 事务折叠古早区：
       一个 checkpoint 节点替换 heavyStart 以前所有节点
       → 60 轮 → 51 节点（10 个古早 → 1 个 checkpoint）
```

**位置即年龄**：分区只按表面位置计算（从尾部数用户轮），不追踪轮次账本。
纯函数在 `src/zones.ts`（`zoneBoundaries(userCount, lightStart, heavyStart)`）。

## 三、四个关键机制

### 3.1 Light：每消息一次 LLM 调用（可并发）

light 区每条消息由**一次小 LLM 调用**蒸馏（纯文本输出）——绝不批量。
教训来自真实数据：一次调用压 200+ 条消息会截断模型输出（静默禁用全部
Light 压缩）且下标对齐易错。

原型默认 **rules 模式**（零 LLM 成本）：超大工具结果做头尾压缩，其余原样。
配置切到 `llm` 模式即启用逐条调用。各条调用相互独立，**可以并发**
（当前原型是串行循环；有界并发是一行改动）。任何失败都保留原文。

### 3.2 Heavy：永不上限——且用我们的压缩

heavy checkpoint 由**我们**的摘要生成，不是 DSH 的：

- 重写 `summarize()`：我们的**语义记忆指令**（身份/环境、硬规则与红线、
  项目锚点、教训、当前目标一句话），走对话自己的 provider/model 路由。
- `maxTokens`（默认 8192）硬上限——**永不超限，构造保证**。
- 增量天然成立：上一轮 checkpoint 在 heavy 范围内，会被再次概括
  （摘要的摘要）——与库的递归 Heavy 同一性质。

与 DSH 天然契合：`compactRegion()` 本来就是"一段 → 一个摘要节点"，
带完整事务（锁、compaction/start|end 标记、稳定性检查、checkpoint 框架）。
我们复用事务，只换摘要内容——零 DSH 改动。

### 3.3 替换 API（你的理解是对的）

对——对话是一个消息数组，一次 API 调用替换其中**一个元素**：

```ts
session.append('user/message', 新消息, {
  surfaceOp: { op: 'replace', start: seq, end: seq },  // start === end → 单节点
  sourceEventSeqs: [seq],
})
```

- 新内容进入模型可见数组的该位置；
- 原始内容留在会话日志里被 **shadow**——永不删除，可查询；
- 三种角色都可替换（user/assistant/tool-result），替换后角色与工具配对
  （`toolCallId`）不变。

### 3.4 抖动窗口：计数器说了算

```ts
count = 表面上的真人用户轮数
if (count < lightStart) return null          // 未达阈值
if (count % lightWindow !== 0) return null   // 不在窗口边界（防抖）
```

`lightWindow`（默认 10）是防抖窗口：只在窗口边界压缩，对话不会频繁抖动。
`context-overflow` 可绕过窗口强制触发。返回 `null` = 本次什么都不做（零成本路径）。

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
    lightDistillMode: 'rules'   # 或 'llm'（逐条调用）
    lightMaxTokens: 1024
    maxTokens: 8192
```

## 六、架构边界

- **原始内容永不删除**——替换只是 shadow，可查询。
- **checkpoint 节点 = heavy 摘要**，受 `maxTokens` 约束。
- **Light 逐条**（每消息一次调用、纯文本）——绝不批量；rules 模式可零 LLM 成本。
- `compaction/start|end` 标记 = 宿主的持久记录（≈ 库的 `onCompress`）。

## 七、原型状态（2026-08-14 已验证）

| 项目 | 结果 |
|---|---|
| typecheck（真实 0.1.0-rc.6 类型） | 通过 |
| zones.spec — 分区边界（含边界相等情形） | 通过 |
| smoke.spec — 真实 Session 上单节点替换 | 通过 |
| pipe.spec — 60 轮种子 → heavy 折叠 60 → 51 节点、标记齐全 | 通过 |

源码：`src/index.ts`（435 行）+ `src/zones.ts`（21 行）= **456 行**，
与主库（<500 行）同量级。测试 156 行。

### 已知限制 / 下一步

1. **手动 `/compact`（`compactNow`）仍继承官方**——手动触发目前产生官方
   一次性摘要而非马赛克通道；统一需要 standalone（owner-null）事务变体。
2. tool-result 节点替换类型合法但只在真实 Session 上演练过 user 节点——
   需在 harness 里验证工具轮。
3. **尚未挂载进真实 DSH profile**（禁 `compaction-basic`、加载本模块、
   长会话端到端实测）。
4. Light 的 llm 模式目前串行；有界并发是简单后续。

## 八、风险与开放问题

- **实现中发现 API 差异（vs 早期源码阅读）不影响算法**：
  (a) `SummarizationInput`/`summarizeWithLlm` 不是公共导出 → `summarize()`
  直接用 `ctx.llm.stream` + `BlockAssembler` 实现；
  (b) 工具结果是 `role:'user'` + `source.kind==='tool'`，不是独立角色 →
  记忆轮计数过滤之；
  (c) `GenerateOptions.provider` 必填、`StreamChunk` 是 delta 流。
  **三区算法、位置即年龄、Light 1:1 替换、Heavy 有界增量全部原样成立，不需要推翻。**
- **触发粒度**：记忆轮（真人用户轮）数为触发单位，与主库一致。
- **KV-cache 影响**：替换事件改变 surface 中部——与官方压缩同成本类别，非新问题。

## 九、范围外

- 多级颗粒度金字塔（理论在设计文档；刻意不实现——工程选择）。
- MCP 服务形态（可能的未来）。
- 修改 DSH 源码（本模块刻意零改动）。