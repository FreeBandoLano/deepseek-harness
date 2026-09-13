# Agent Note: 每个 agent 的工具选择直达已记录的请求 header 与协议线路

Status: implemented

[English](2026-09-13-tool-choice-request-header.md) | 中文

## 问题

部署需要能够声明：某个 agent 的对话轮次必须调用工具，并且这一要求由提供方执行，而不是写在一段模型可以无视的 persona 文字里。触发这一需求的 agent 的规则是：没有跑过仿真就不算数——文字无法强制它，而 OpenAI 兼容网关接受 `tool_choice: "required"`。

改动前 harness 无处表达这一要求。`AgentOptions` 只带 provider、model 和一个输出上限；`GenerateOptions` 与 `LlmCallConfig` 都没有工具选择字段；而 pi-ai 适配器只向 SDK 转发一份显式白名单，未点名的字段根本不会离开进程。依赖本身已经携带该字段并把它写入请求体，所以这是一处管线缺口，而不是能力缺失。

## 决定

工具选择是每个 agent 自己的状态。它声明在 subagent 工具行既有的 `agentOptions` 块中，与 provider、model、输出上限并列，字段名为 `toolChoice`，并使用协议自身的词汇——`'none'`、`'auto'`、`'required'` 或具名函数——因此日后要指定某个函数也无需第二个选项。

该值作为请求 header 的事实传递，而不是走旁路：

1. `AgentOptions.toolChoice`（`packages/core/agent/src/runtime-types.ts`）是 subagent 工具行交给子循环的 agent 级声明。
2. 随附的 `dsh-tool-subagent` 配置 schema 在该块中接受它，因此 `cordis.yml` 行可以在 agent 的其他事实旁边声明它。
3. agent 循环在它记录的第一份请求 header 中写入该值（`packages/core/agent-loop/src/agent.ts`）；此后的每个请求都通过展开该已记录 header 组装。
4. `LlmCallConfig.toolChoice`（`packages/llm/llm/src/call-config.ts`）使它成为 header 状态，因此 `callConfigEquals`——进而 `headerEquals`——把它的一次改动视为真实改动，循环会记录一份变更后的 header 快照，而不是静默替换。
5. `GenerateOptions.toolChoice`（`packages/llm/llm/src/types.ts`）把它带入组装完成的请求。
6. pi-ai 适配器把它转发给 `Models.streamSimple()`（`packages/llm/llm-pi-ai/src/adapter.ts`），该简单流入口把 harness 的推理档位映射为协议的 effort，并把该字段写入请求体。

针对带种子日志新建的循环实例优先采用手上的声明；否则，当已持久化的路由与它启动时所用的路由一致时，从已记录的 header 恢复该值。日志不同意的路由会丢掉它，而这次丢弃本身就是一次已记录的 header 变更。

辅助模型调用永远不会被强制。压缩与会话标题只从会话 header 推导 provider 与 model，因此该要求无法到达它们；压缩与会话标题两套测试各自钉住了这一点。

## 曾考虑的替代方案

**布尔值 `mustCallTool` 标志。** 否决：它无法表达“不要调用工具”，而一旦要指定某个函数就还需要第二个字段。

**通过既有的 `agent/request` 瀑布按轮次表达该要求。** 否决：它仍然需要同一个请求字段，却为表达一个事实而新增一个部署插件，同时把声明留在没有任何 agent 行能承载的地方。

**全局的“每个 agent 都必须调用工具”策略。** 否决：它会强制那些本就以文字作答的 agent。

**把适配器切换到声明了工具选择的协议完整流入口。** 否决：简单入口才是把 harness 推理档位映射为协议 effort 的那个入口，并且它拥有重试与重放边界。适配器改为在该入口转发的选项里点名此字段，并由适配器测试钉住所产生的请求体。

**把该要求写进可续期 subagent 的 descriptor。** 否决：descriptor 为冷恢复快照组合事实，而它省略的字段会从子会话自己的已记录 header 恢复，那已经是该子会话请求构建依据的持久记录。两处都存会让一个事实有两个真相来源，而提升 `SUBAGENT_DESCRIPTOR_VERSION` 会让磁盘上所有可续期子会话失联。

## 影响

声明了 `toolChoice` 的 agent 行，在它构建的每个对话请求上都会被提供方强制，并且该要求能在恢复后存活，因为承载它的是日志而不是调用方。

只有 pi-ai（OpenAI 兼容）路由会携带它。DeepSeek 适配器有自己的请求翻译并忽略该字段，因此结构上无法承载该声明的路由目前不会被拒绝；在最早可知点拒绝它的改动另行跟踪。在该改动落地之前，位于没有该字段的路由上的 `toolChoice` 是静默不被强制的。网关接受该字段却无视它，是另一处缺口，而这一处已经封闭：应答半边会让一个以文字作答的被强制轮次失败，而不是把它当作成功放行——详见[被强制的轮次会响亮失败](2026-09-13-tool-choice-enforcement.zh.md)。

由于该值从已记录 header 恢复，从配置行中删除 `toolChoice` 无法取消一个已经在进行的会话的强制；该要求通过 `agent/request` 瀑布改变，且该改变会被记录。这种不对称是刻意的：本设计防范的失败是恢复时悄悄削弱强制，而不是保持强制。

没有改动任何 persona 文本，也没有改动任何 agent 的路由模型。

## 测试

`packages/llm/llm-pi-ai/tests/adapter.spec.ts` 断言捕获到的请求体在映射后的 `reasoning_effort` 旁边带有 `tool_choice: "required"`，并断言未声明该要求的同一请求不带 `tool_choice`、但仍然列出工具。`packages/subagent/tool-subagent/tests/tool-choice-wire.spec.ts` 让真实的 subagent 工具行穿过进程内委派栈抵达同一个 mock 端点，并断言委派轮次的请求体，以未声明的行为对照。`packages/core/agent-loop/tests/request-reconstruction.spec.ts` 钉住已记录 header、变更 header 路径与恢复重建；`packages/core/agent-loop/tests/invariant.spec.ts` 钉住“请求对比折叠 header”的检查，正是它让未被记录的要求不可能存在。
