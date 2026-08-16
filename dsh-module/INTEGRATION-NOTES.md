# DSH 集成踩坑实录（Integration Notes）

> 2026-08-16 真实挂载验证过程中的深层发现。每个坑：现象 → 根因 → 解法。
> 对任何 DSH 插件开发者都有参考价值；主设计见 DESIGN.cn.md。

## 1. 本地路径插件必须用 CJS（.cjs），ESM .js 会静默不加载

**现象**：cordis.patch.yml 的 insert 条目 name 指向 ESM 构建产物
（dist/index.js）时，重启后插件**没有任何加载迹象**——无报错、无日志、
服务不注册。同样的 insert 机制下 boot-restore（index.cjs）正常工作。

**根因**：DSH 的 cordis loader 对本地路径插件走 CJS 加载路径；ESM 产物
要么被跳过要么加载失败被静默。Node 22 的 require(ESM) 能工作，但 loader
的实际路径不接受。

**解法**：tsup 双格式输出（format: ['esm', 'cjs']），patch name 指向
dist/index.cjs。立即生效。

**教训**：修改插件后**必须加运行期诊断再验证**——插件入口
console.log 一行，重启后查 journal（systemd journal 是唯一可靠通道）。
lsof 不可靠：模块加载完成后文件句柄即关闭，查不到。

## 2. 计数口径：只有 source.kind === 'user' 才是"一轮"

**现象**：宽松口径（role==='user' 且非 tool）数出 159 轮，而真实用户
消息只有 80 条。

**根因**：真实 DSH 会话里系统注入消息（runtime context、time-context、
AGENTS.md 等，source.kind='plugin'）数量巨大——每轮 1-2 条，长期会话
中与真实消息几乎 1:1。加上工具结果（'tool'）与官方 checkpoint
（'plugin' + plugin:'compact'），宽松口径严重偏斜。

**解法**：`isUserRound = role==='user' && source.kind==='user'`——
与"用户发一条消息 = 一轮"的模型精确一致。checkpoint 用官方
`isCompactCheckpointSource` 谓词排除（不要自己匹配字符串）。

## 3. 官方 checkpoint 会重置 surface 的"记忆年龄"

**现象**：会话 8/14 被官方 /compact 过一次；挂载后 R 只有 23（< 30 阈值），
不触发压缩。

**根因**：官方 /compact 把早期全部消息 shadow 了，surface 上只剩
checkpoint 节点 + 之后的真实消息。**计数基于 surface（模型可见面）**，
被 shadow 的轮次不计入——surface 即记忆，官方压缩 = 记忆重置。

**结论**：这是**正确语义不是 bug**。官方压缩过的会话需要重新积累轮数
才触发。若想立即验证，用临时小阈值；真实使用中无官方压缩时行为符合
设计（50 轮以下不压）。

## 4. 触发精确性：摘要节点污染轮计数

**现象**：heavy 折叠后，摘要对的 user 节点被 findRoundStarts 计入轮数，
触发点漂移（69/78/87 而非 60/70/80）。

**解法**：主库 Message 加内部标记 `_heavy`（摘要对）与 `_distilled`
（已脱水）。findRoundStarts 跳过 _heavy；light 只处理非 _distilled——
**增量语义**：每次触发只蒸馏新滚入窗口（10 轮），重复触发绝不二次蒸馏。
真实逐轮模拟：LLM 调用 1066 → 256（理论最优），触发点精确锁定窗口边界。

## 5. 空/占位消息必须短路，否则模型返回空回复

**现象**：16/1066 次 light 调用返回空（曾误报 35%——把"短消息原样保留"
误计为失败）。全部是空占位输入：[tool-call: xxx]（无文本）、{}、空 JSON。

**解法**：`lightSkipThreshold`（默认 160）——空/占位/已蒸馏的短消息
直接保留原文，零 LLM 调用。修复后失败率 0。附带收益：蒸馏产物变短 →
下次触发自动跳过 → 无状态框架下近似增量。

## 6. pre-step 事件的 agent 注入

**现象**：排查 pre-step 钩子时发现 waterfall payload 只有
{messages, turn, step, signal}，怀疑 agent 为 undefined。

**根因**：agentEvents() 工厂（dsh-agent）的 fused() 包装给 payload 追加
agent——钩子解构 { agent, signal } 成立。官方机制，无需处理。

## 7. 验证方法论：挂载会改写 agent 记忆

- 挂载前：导出会话 + 三区快照 + 预期清单（参考 ~/mosaic-validation/ 模式）
- 挂载后：journal 查加载诊断 → 会话日志查 compaction 事件与 surface 替换
- shadow 语义保证原始事件永在日志，最坏情况可恢复

## 8. 其他确认过的点

- patch.yml 用 js-yaml JSON_SCHEMA 解析（+!!js 表达式）；insert 条目
  支持 id/name/config，config 直接传给插件
- 依赖版本：dsh-module 的 @deepseek-ai peerDeps 与 DSH 运行时
  profiles/node_modules 同版本（0.1.0-rc.6）时兼容；双份 node_modules
  的 cordis 靠全局 Symbol 品牌跨拷贝兼容
- compaction-basic 在 web-app bundle 中已被官方禁用（host 层）——
  preset 层是否挂载官方后端需按版本核对

## 9. O(n²) 事件查找：pre-step 实测 17.7 秒（已修复）

**现象**：挂载后每次发消息前 GUI 无反应数秒；journal 显示
`[mosaic] pre-step R=25 no-op (17730ms)`。

**根因**：surfaceNodes() 对每个 surface 节点用 events.find(seq) 线性查找——
80 轮对话产生 3.8 万条事件 × 675 个表面节点 = 2565 万次比较/每次 pre-step。

**解法**：Map 索引（O(n) 建索引 + O(1) 查找）→ 17730ms → 132ms。

**教训**：真实会话的事件量是对话轮数的 ~500 倍（tool 调用、chunk、reasoning
都算事件）——任何按 seq 的查找都必须索引，禁止线性 find。

## 10. 增量轮计数：O(1) no-op pre-step（2026-08-16 设计）

**问题**：即使 Map 索引，每次 pre-step 全量扫描仍是 O(n)，会话增长会退化
（10 万事件 ≈ 400ms，100 万 ≈ 秒级）。

**设计**（正确性由三条规则封闭）：
- **增量维护**：监听 `session/event`（append-only 流）——真实用户消息
  （source.kind==='user'）append 时计数 +1；
- **1:1 替换不失效**：light 蒸馏（start===end 替换）保留 user source，
  轮数不变，不标脏；
- **范围折叠标脏**：任何 start!==end 的替换（heavy 折叠、官方 checkpoint、
  第三方压缩）→ dirty → 下次 pre-step 全量对账。
- **懒初始化**：新会话/重启后首次 pre-step 全量扫描一次；触发路径
  （窗口边界）本来就全量算 zones，顺带校正。

**实测**：no-op 124ms（初始化）→ **0ms**（增量）；journal R 与 surface
全量计数逐轮对账一致。

## 11. pre-step 诊断日志（验证方法论）

模块在 compactIfNeeded 记录一行 journal：
`[mosaic] pre-step R=NN trigger=pressure no-op (Xms)` / TRIGGERED 变体
（lightCalls/lightTokens/heavyFolded/耗时）。重启后 journal 是唯一可靠的
验证通道（lsof 不可靠——模块加载后文件句柄关闭）。

## 12. Light 重构：LLM 蒸馏 → 纯结构化截断（2026-08-16）

**数据驱动决策**：真实 40 轮 surface 的 token 构成——reasoning 33% +
tool-call arguments 33% + tool-result 24% + 注入 4% + **文本仅 5%**。
LLM 蒸馏文本是"90% 成本打 10% 的靶"：254 次调用/12s/38 万 token 只换
5.6% 净省。

**新方案（实测对比）**：结构化截断（reasoning 头尾 30、arguments JSON 壳
120、结果头 300 尾 200、注入 200、文本不动）→ 46.1% 净省、零 LLM、毫秒级。

**API 安全性全部实测**（DeepSeek 官方接口）：
- reasoning_content 截断/删除 → 200 OK，回答正确（finish_reason=stop）
- arguments 纯文本/JSON 壳截断 → 200 OK（只校验结构不校验内容）
- tool_call_id 配对保留 → 无 400

**对 DSH 的启示**：surface 的大头是结构化内容（reasoning/arguments/result），
不是文本——任何上下文压缩都应先处理结构化负载。
