# MosaicMemoryCompress

[![Supports DeepSeek Harness](https://img.shields.io/badge/Supports-DeepSeek%20Harness-blue)](https://github.com/deepseek-ai/deepseek-harness)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

**基于自然遗忘曲线的无状态对话压缩。**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](https://www.typescriptlang.org)
[![GitHub stars](https://img.shields.io/github/stars/TuringCorp-net/mosaic-memory-compress)](https://github.com/TuringCorp-net/mosaic-memory-compress/stargazers)

LLM 对话线性增长，MosaicMemoryCompress 让它们**永远有界**——自动、无感，用户甚至
不需要知道"会话"是什么。

## 工作原理

```
消息数组（R 轮，从旧到新）：

第 1 轮 ────→ 第 (R-40) 轮   │ Heavy 区 → 全部 → 1 条检查点消息
第 (R-39) 轮 → 第 (R-10) 轮  │ Light 区 → 逐条脱水，数量不变
第 (R-29) 轮 ──→ 第 R 轮     │ Raw 区  → 原样保留
```

**稳态消息数恒定**——`2 + heavyStart × 每轮消息数`（纯双消息对话为 62 条，31 个用户轮），
第 60 轮还是第 15,000 轮都一样。压缩率趋近 100%。

## 设计哲学：鲜活的记忆，不是交接简报

行业通用做法是阈值触发的一次性全量总结：窗口满了就把全部历史压成一份简报，
交给"看过笔记的新人"——最近的细节也在最该鲜活的地方被转述丢失，且损失不可见。

MosaicMemoryCompress 模拟的是**生物遗忘曲线**：人不会记得 300 轮对话的第 3 轮，
只会留下教训、规则与关系。算法在同一份消息数组里复现这条曲线：

```
最近 10 轮    → 逐字保留（鲜活——正在做的事）
第 10-40 轮   → 结构化截断（reasoning/参数/结果精简，文本保留）
第 40 轮以前  → 一条检查点：身份、环境、权限、规则
```

没有切换时刻、没有重置、没有长度上限。**损失是可见的**：分区结构告诉模型
它不再知道什么，需要时可以从 shadowed 存储取回细节。

| | 阈值总结（行业通用） | MosaicMemoryCompress |
|---|---|---|
| 比喻 | 失忆 + 读日记 | 连续的鲜活记忆 |
| 连续性 | 每次压缩都重置 | 永不重置 |
| 损失 | 无差别、不可见 | 渐进、可见 |
| 近期轮次 | 在最该鲜活的时刻被转述 | 永远逐字 |
| 目的 | 可移植的交接简报 | 无界的人机对话 |

**最重要的应用场景**：无法做对话管理的设备——车载 AI 助手（方向盘上没有
"新对话"按钮）、智能音箱/家居中枢（纯语音、没有文件管理）、随身/环境设备
（无设置界面）。这些场景下，对话悄悄死亡或重置成简报不是小麻烦，而是关系的
断裂。马赛克记忆压缩让对话在设备自身的内存预算内无限延续：最近几轮逐字保留
（用户永远不会面对陌生人）、旧轮自然淡忘、核心规则永远活在检查点里。

两种哲学互补：交接简报服务于冷启动与长中断；MosaicMemoryCompress 服务于
**留在对话里**。配合宿主持久存储（如 MEMORY.md），人与 AI 可以在同一条
遗忘曲线下无限对话。[设计文档](docs/design.cn.md) §8/§10 给出了位置即年龄
模型的形式化基础，§9 是"同一事件、三种记忆载体"的实证案例。

## 快速开始

```bash
npm install mosaic-memory-compress
```

```typescript
import { mosaicMemoryCompress, DEFAULT_CONFIG, type MosaicMemoryConfig } from 'mosaic-memory-compress';

const config: MosaicMemoryConfig = {
  ...DEFAULT_CONFIG,
  callLLM: async (systemPrompt, userInput) => {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userInput },
      ],
    });
    return res.choices[0].message.content ?? '';
  },
};

// 每轮调用一次——阈值以下零成本；结构化 light 毫秒级，Heavy 折叠约 1-2 秒
const compressed = await mosaicMemoryCompress(messages, config);
```

## 特性

- **无状态 & 可重复**——无会话状态；每轮调用，输出可直接作为输入
- **阈值以下零成本**——未到压缩点时立即返回
- **防抖动**——只在窗口边界压缩
- **模型无关**——自带 `callLLM`（OpenAI、Anthropic、本地模型…）
- **工具调用安全**——工具消息不破坏轮次计数
- **优雅降级**——LLM 失败不阻断对话

## DeepSeek Harness 集成

> **⚠️ 从 DSH 0.1.5 起：请直接用官方压缩，不要安装本适配器。**
>
> 0.1.5 的官方 `compaction-basic` 已经实现了本适配器的**核心逻辑**：近区原文
> 逐字保留（默认 = 窗口的 16%，1M 窗口即 16 万 token）+ 更早内容折成**一个**
> 有界 checkpoint，压力触发、不打断对话，并且额外有溢出恢复、持久锁、事务、
> 重放稳定性校验与 KV cache 复用的摘要调用——安全性远好于本适配器。
> 唯一没有对应物的是 **Light 区**（零 LLM、按年龄的结构脱水）；单独为这一项
> 维护第二套压缩引擎 + 逐版跟 DSH 适配不划算，而且同样的效果用官方配置就能
> 逼近：
>
> ```yaml
> # preset 组合里的 compaction-basic 行（0.1.5 起这三行属于 preset，不再是宿主行）
> config:
>   thresholdRatio: 0.15   # 到窗口 15% 就压（1M 窗口 → 15 万 token）
>   retainRatio: 0.05      # 近区保留 5%（→ 5 万 token）
> ```
>
> 也可以不改 preset，直接在 `$DSH_HOME/settings.yaml` 的 `llm-deepseek:` 段把声明的
> `defaultContextWindow` 改小（热加载、不用重启，真请求仍按模型真实窗口发）。
> 注意 `retainRatio` 必须小于 `thresholdRatio`；配错时自动压缩会**只警告一次然后
> 静默不再压缩**，改完务必看启动日志。
>
> 完整代码级对比与结论（含 0.1.5 把压缩移进 preset 隔离 realm 的影响）：
> [`dsh-module/INTEGRATION-NOTES.md`](dsh-module/INTEGRATION-NOTES.md) §21。
> **≤ 0.1.2 的宿主仍可用本适配器**；与本仓库的通用算法库无关。

MosaicMemoryCompress 的 DSH 插件后端在 [`dsh-module/`](dsh-module/DESIGN.cn.md)：
`MosaicMemoryCompactionEngine` 继承官方 `BasicCompactionEngine`，把三区遗忘曲线
带进 DSH 会话——Light 结构化截断（1:1 表面替换，原始进 shadow），Heavy 折叠为
单个永不超上限的 checkpoint。中文设计文档：[dsh-module/DESIGN.cn.md](dsh-module/DESIGN.cn.md)。

安装到 DSH profile（包内声明 `dsh.bundle`）：

```bash
dsh plugin --profile web add mosaic-memory-compress      # registry 包
# 不走 npm 的话，直接从公开仓装：
dsh plugin --profile web add github:TuringCorp-net/mosaic-memory-compress
```

**⚠️ 升级 DSH 前请注意（0.1.5）**：在 **DSH ≤ 0.1.2 上用 v1.3.2 之前的马赛克**
压缩过的会话，含 assistant 级 1:1 替换事件，无法通过 0.1.5 的会话迁移审计——
升级后这些会话会拒绝加载（`assistant/message … chunk provenance is not one
complete ordered attempt`）。**原始日志不会被改动**（内容没丢），但会话打不开了，
插件侧没有修复手段；需要时用只读的
[`scripts/salvage-session.py`](scripts/salvage-session.py) 把对话导出成 Markdown。
正确顺序：**先把马赛克升到 v1.3.2+，再升级 DSH**（此后在 0.1.5 上不再写这类事件）。
完整分析见 [`dsh-module/INTEGRATION-NOTES.md`](dsh-module/INTEGRATION-NOTES.md) §19。

相关：

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — 宿主平台
- [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) — DSH 插件精选
- [设计文档（中文）](docs/design.cn.md) — 理论与实证

## 基准

确定性模拟（零 LLM 成本、可复现），真实算法 + 规则伪 LLM：

```bash
npm run bench                        # 合成扫描：100 / 500 / 1000 / 5000 轮
npm run bench -- --file chat.json    # 分析你自己的对话文件
```

详见 [benchmark/README.md](benchmark/README.md)（方法、数据、局限与真实 LLM
抽查 `npm run bench:real`——DeepSeek V4 Flash，<$0.01，5/5 事实保持）。

## 开发

```bash
npm test          # 零 LLM 成本（mock 响应）
npm run typecheck
```

## License

MIT — [TuringCorp](https://www.turingcorp.net) | [iAsk@turingcorp.net](mailto:iAsk@turingcorp.net)
