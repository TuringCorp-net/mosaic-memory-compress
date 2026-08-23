# AGENTS.md — mosaic_compress 项目规则

> 本文件由全局记忆拆分而来（2026-08-23），项目细节记忆在 **MEMORY.md**（同目录，按需读）。

## 项目是什么
- 无状态对话压缩库，基于遗忘曲线；TS/ESM，v1.0.0，MIT。位于 coding/mosaic_compress，分支 main。
- 上游公开仓库：TuringCorp-net/mosaic_compress。

## 铁律
- **TODO-LOCAL.md 是本地文件，不推送**。
- 评测三层全完成前不改核心算法；改动必须过 bench（模拟器）+ bench:real（真实 LLM 抽查）。
- DSH 插件后端在 dsh-module/（MosaicCompactionEngine extends 官方 BasicCompactionEngine，外挂插件，不动 DSH 源码）。
- 稳态公式：2 + heavyStart × 每轮消息数（纯对话 102 条；文档 82 为笔误已修正）。
