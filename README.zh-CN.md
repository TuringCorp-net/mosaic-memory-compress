# MosaicCompress

**基于自然遗忘曲线的无状态对话压缩。**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](https://www.typescriptlang.org)
[![GitHub stars](https://img.shields.io/github/stars/TuringCorp-net/mosaic_compress)](https://github.com/TuringCorp-net/mosaic_compress/stargazers)

LLM 对话线性增长，MosaicCompress 让它们**永远有界**——自动、无感，用户甚至
不需要知道"会话"是什么。

## 工作原理

```
消息数组（R 轮，从旧到新）：

第 1 轮 ────→ 第 (R-50) 轮   │ Heavy 区 → 全部 → 2 条摘要消息
第 (R-49) 轮 → 第 (R-30) 轮  │ Light 区 → 逐条脱水，数量不变
第 (R-29) 轮 ──→ 第 R 轮     │ Raw 区  → 原样保留
```

**稳态消息数恒定**——`2 + heavyStart × 每轮消息数`（纯双消息对话为 102 条），
第 60 轮还是第 15,000 轮都一样。压缩率趋近 100%。

## 设计哲学：鲜活的记忆，不是交接简报

行业通用做法是阈值触发的一次性全量总结：窗口满了就把全部历史压成一份简报，
交给"看过笔记的新人"——最近的细节也在最该鲜活的地方被转述丢失，且损失不可见。

MosaicCompress 模拟的是**生物遗忘曲线**：人不会记得 300 轮对话的第 3 轮，
只会留下教训、规则与关系。算法在同一份消息数组里复现这条曲线：

```
最近 30 轮    → 逐字保留（鲜活——正在做的事）
第 30-50 轮   → 结构化截断（reasoning/参数/结果精简，文本保留）
第 50 轮以前  → 一条摘要对：身份、环境、权限、规则
```

没有切换时刻、没有重置、没有长度上限。**损失是可见的**：分区结构告诉模型
它不再知道什么，需要时可以从 shadowed 存储取回细节。

| | 阈值总结（行业通用） | MosaicCompress |
|---|---|---|
| 比喻 | 失忆 + 读日记 | 连续的鲜活记忆 |
| 连续性 | 每次压缩都重置 | 永不重置 |
| 损失 | 无差别、不可见 | 渐进、可见 |
| 近期轮次 | 在最该鲜活的时刻被转述 | 永远逐字 |
| 目的 | 可移植的交接简报 | 无界的人机对话 |

两种哲学互补：交接简报服务于冷启动与长中断；MosaicCompress 服务于
**留在对话里**。配合宿主持久存储（如 MEMORY.md），人与 AI 可以在同一条
遗忘曲线下无限对话。[设计文档](docs/design.cn.md) §8/§10 给出了位置即年龄
模型的形式化基础，§9 是"同一事件、三种记忆载体"的实证案例。

## 快速开始

```bash
npm install mosaic-compress
```

```typescript
import { mosaicCompress, DEFAULT_CONFIG, type MosaicConfig } from 'mosaic-compress';

const config: MosaicConfig = {
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
const compressed = await mosaicCompress(messages, config);
```

## 特性

- **无状态 & 可重复**——无会话状态；每轮调用，输出可直接作为输入
- **阈值以下零成本**——未到压缩点时立即返回
- **防抖动**——只在窗口边界压缩
- **模型无关**——自带 `callLLM`（OpenAI、Anthropic、本地模型…）
- **工具调用安全**——工具消息不破坏轮次计数
- **优雅降级**——LLM 失败不阻断对话

## DeepSeek Harness 集成

MosaicCompress 的 DSH 插件后端在 [`dsh-module/`](dsh-module/DESIGN.cn.md)：
`MosaicCompactionEngine` 继承官方 `BasicCompactionEngine`，把三区遗忘曲线
带进 DSH 会话——Light 逐条蒸馏（1:1 表面替换，原始进 shadow），Heavy 折叠为
单个永不超上限的 checkpoint。中文设计文档：[dsh-module/DESIGN.cn.md](dsh-module/DESIGN.cn.md)。

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
