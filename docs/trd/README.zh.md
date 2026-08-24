# PilotDeck 功能 TRD 索引

状态：评审中　维护者：PilotDeck 工程团队　适用范围：Agent Runtime、Gateway、模型、工具、自动化、平台入口和 UI。

本目录把功能边界拆成独立 TRD。每份文档只拥有一个主要责任边界，跨模块行为通过源码、事件和测试映射连接，不复制另一份文档的实现细节。

## 主 TRD

| 编号 | 文档 | 主要边界 |
| ---: | --- | --- |
| 01 | [Gateway Wire Protocol](01-gateway-wire.zh.md) | WebSocket frame、鉴权和流式协议 |
| 02 | [Gateway Runtime Lifecycle](02-gateway-lifecycle.zh.md) | busy、abort、close、replay 和 shutdown |
| 03 | [Core Agent Loop](03-agent-loop.zh.md) | AgentLoop 多轮模型/工具循环 |
| 04 | [AgentSession](04-agent-session.zh.md) | session state、turn identity 和 reload |
| 05 | [TurnRunner](05-turn-runner.zh.md) | 输入、transcript、hook、title、artifact |
| 06 | [Agent Event Contract](06-agent-events.zh.md) | AgentEvent 配对、identity 和终态 |
| 07 | [Token Budget](07-token-budget.zh.md) | context/input/output token 预算 |
| 08 | [Prompt Projection](08-prompt-projection.zh.md) | system、history、tool、attachment projection |
| 09 | [Compaction Engine](09-compaction-engine.zh.md) | full/rolling summary 和 checkpoint |
| 10 | [Micro Compaction](10-micro-compaction.zh.md) | 局部裁剪和重复内容压缩 |
| 11 | [Context Recovery](11-context-recovery.zh.md) | overflow、summary failure 和恢复重试 |
| 12 | [Memory Runtime](12-memory-runtime.zh.md) | memory capture、检索和失败隔离 |
| 13 | [Attachment Context](13-attachment-context.zh.md) | 图片、文件和附件投影 |
| 14 | [Canonical Model Protocol](14-canonical-model.zh.md) | canonical message、tool、usage、错误 |
| 15 | [OpenAI Chat Adapter](15-openai-chat.zh.md) | Chat Completions 协议适配 |
| 16 | [OpenAI Responses Adapter](16-openai-responses.zh.md) | Responses item/event 适配 |
| 17 | [Anthropic Messages Adapter](17-anthropic-messages.zh.md) | Messages、cache、tool result |
| 18 | [Google Gemini Adapter](18-google-gemini.zh.md) | Gemini request/response/stream |
| 19 | [Stream Assembly](19-stream-assembly.zh.md) | SSE、chunk、tool-call assembler |
| 20 | [Router Decision](20-router-decision.zh.md) | scenario、model、sticky 和 capability |
| 21 | [Token Saver Classification](21-token-saver.zh.md) | judge、tier 粘性和重新分类 |
| 22 | [Orchestration Policy](22-orchestration.zh.md) | subagent、prompt 注入和模式过滤 |
| 23 | [Fallback Policy](23-fallback.zh.md) | provider fallback 和失败 attempt |
| 24 | [Retry and Provider Health](24-retry-health.zh.md) | retry、backoff、health 和预算 |
| 25 | [Tool Registry](25-tool-registry.zh.md) | builtin 注册和可用性 |
| 26 | [Tool Description and Schema](26-tool-description-schema.zh.md) | description、schema 和 token 预算 |
| 27 | [Tool Filtering](27-tool-filtering.zh.md) | allowlist、plan、ask、subagent 过滤 |
| 28 | [Tool Scheduler](28-tool-scheduler.zh.md) | sequential/concurrent 调度 |
| 29 | [Tool Execution Result](29-tool-execution-result.zh.md) | 执行、结果、timeout、progress |
| 30 | [Permission Decision](30-permission.zh.md) | deny/allow/safety 和交互回答 |
| 31 | [Lifecycle Hook](31-lifecycle-hooks.zh.md) | hook matching、effect 和 block |
| 32 | [Extension Plugin](32-extension-plugin.zh.md) | plugin、manifest、reload、contribution |
| 33 | [Skill Runtime](33-skill-runtime.zh.md) | skill scope、加载、迁移和注入 |
| 34 | [MCP Runtime](34-mcp-runtime.zh.md) | MCP client、server、sanitize 和 bridge |
| 35 | [Transcript Replay](35-transcript-replay.zh.md) | JSONL、sequence、replay 和旧格式 |
| 36 | [Session Metadata and Title](36-session-metadata-title.zh.md) | metadata、title 和并发覆盖 |
| 37 | [File History and Artifact](37-file-history-artifact.zh.md) | backup、restore、artifact 和回滚 |
| 38 | [Path and Worktree Safety](38-path-worktree-safety.zh.md) | workspace、symlink、worktree 和路径边界 |
| 39 | [Always-On Runtime](39-always-on.zh.md) | discovery、plan、report、apply 和 lease |
| 40 | [Cron Scheduler](40-cron.zh.md) | cron store、schedule、fire 和竞态 |
| 41 | [Background Task](41-background-task.zh.md) | task create、wait、output 和 stop |
| 42 | [Adapter and IM Contract](42-adapter-contract.zh.md) | 公共 channel 生命周期和消息契约 |
| 43 | [Web API](43-web-api.zh.md) | REST、SSE、上传、项目和命令 |
| 44 | [Gateway Bridge](44-gateway-bridge.zh.md) | UI bridge、RPC 转发和事件映射 |
| 45 | [UI Store and Reducer](45-ui-store-reducer.zh.md) | session slot、history/live 和 pending 状态 |
| 46 | [UI Interaction](46-ui-interaction.zh.md) | 对话交互 PRD 和用户验收 |
| 47 | [CLI and Local Server](47-cli-local-server.zh.md) | CLI、Gateway 启动和 shutdown |
| 48 | [Configuration and Runtime](48-configuration-runtime.zh.md) | config merge、reload、credential 和 PILOT_HOME |
| 49 | [Network Request](49-network-request.zh.md) | fetch、timeout、retry、abort 和代理 |
| 50 | [Telemetry Runtime](50-telemetry-runtime.zh.md) | collector、sender、队列和脱敏 |

## 平台附录

平台附录只记录平台差异，不重新定义公共 Adapter 契约：

| 平台 | 附录 |
| --- | --- |
| Feishu | [feishu.zh.md](platforms/feishu.zh.md) |
| Weixin | [weixin.zh.md](platforms/weixin.zh.md) |
| Signal | [signal.zh.md](platforms/signal.zh.md) |
| WeCom AI Bot | [wecom.zh.md](platforms/wecom.zh.md) |
| WeCom Callback | [wecom-callback.zh.md](platforms/wecom-callback.zh.md) |
| Discord | [discord.zh.md](platforms/discord.zh.md) |
| Telegram | [telegram.zh.md](platforms/telegram.zh.md) |
| Slack | [slack.zh.md](platforms/slack.zh.md) |
| WhatsApp | [whatsapp.zh.md](platforms/whatsapp.zh.md) |
| DingTalk | [dingtalk.zh.md](platforms/dingtalk.zh.md) |
| QQ | [qq.zh.md](platforms/qq.zh.md) |
| Matrix | [matrix.zh.md](platforms/matrix.zh.md) |
| Mattermost | [mattermost.zh.md](platforms/mattermost.zh.md) |
| Email | [email.zh.md](platforms/email.zh.md) |
| SMS | [sms.zh.md](platforms/sms.zh.md) |
| BlueBubbles | [bluebubbles.zh.md](platforms/bluebubbles.zh.md) |
| Home Assistant | [homeassistant.zh.md](platforms/homeassistant.zh.md) |
| Webhook | [webhook.zh.md](platforms/webhook.zh.md) |
| API Server | [api-server.zh.md](platforms/api-server.zh.md) |
| CLI | [cli.zh.md](platforms/cli.zh.md) |
| TUI | [tui.zh.md](platforms/tui.zh.md) |

每份附录必须说明鉴权、`start/stop`、session key、入站/出站、附件、permission/elicitation、busy、重复投递、重连、资源清理、测试映射和 `DEFER_EXTERNAL` 状态。

## 维护规则

源码边界、事件字段、持久化格式或用户流程变化时，必须更新对应 TRD、Agent Note 和测试映射。当前通过不等于历史回归证明；没有 mutation 或 parent failure 时应保持 `CURRENT_ONLY`。
