# PilotDeck 测试质量路线图

状态：评审中　维护者：测试与 Runtime 团队　目标读者：贡献者、代码代理、评审者和 CI 维护者

## 证据原则

测试必须从可重复的行为契约出发。当前分支测试通过只能记录为 `CURRENT_ONLY`；在修复父提交上复现失败记录为 `PARENT_FAIL`；精确反向 mutation 使目标测试失败记录为 `MUTATION_FAIL`。真实模型、平台账号、公网网络、浏览器和 Docker 场景必须单独标记 `DEFER_EXTERNAL`，不得静默跳过。

每个 TRD 的契约按以下链路追溯：

```text
TRD 契约 -> 代码边界 -> 确定性测试 -> mutation/历史失败证据 -> CI gate -> 构建产物或入口复验
```

## P0：基线和统一门禁

### 目标

建立可执行的 root/UI 基线、文档检查、契约测试和构建产物检查，禁止运行时不匹配或测试收集错误造成假绿。

### 当前入口

- `pnpm run check:docs`：检查 50 份主 TRD、21 份平台附录、源码/测试映射和敏感信息。
- `pnpm run test:contract`：构建后运行 Gateway、模型请求和 stream 的确定性契约测试。
- `pnpm run test:artifact`：构建后检查 CLI、Gateway、Model 的 dist 入口。
- `pnpm run test:coverage`：使用 Node 原生 test coverage 检查已迁移模块；当前覆盖 task、status、telemetry、lifecycle runtime、permission、MCP 纯函数、Router fallback/health/retry/session/tokenSaver/config、Transcript/Context 边界、Gateway 小模块、四协议模型适配、配置解析/reload、AgentLoop、Always-On storage/web、ChatDigest、DiscoveryPlanStatus 和 workspace、SessionLite/search、插件 manifest/discovery/registry、resume、CLI chat search、context extension、custom router 以及 builtin web/filesystem 纯逻辑。Node 22.23.1 下最近一次聚合结果为 907 个测试、96.87% 行、85.44% 分支和 93.84% 函数覆盖；聚合行覆盖率门槛为 90%，函数覆盖率门槛为 80%，脚本另外强制每个纳入统计的源码模块行覆盖率不低于 90%。`AutoCompactionPolicy`、`CachedMicroCompactionEngine`、`stripMultimedia`、Agent 配对/子 agent 过滤、`parseRouterConfig`、`parseTextToolCalls`、`SessionLiteReader`、Always-On Chat History、ChatDigest、DiscoveryPlanStatus、resume、CLI chat search、context extension、custom router、URL validation/cache/fetch、SignalWatcher 和 builtin filesystem 边界已达到 90%+ 行覆盖；`TurnRunner` 及部分 Always-On/workspace 模块的局部函数覆盖仍低于 80%，但不降低逐模块行覆盖门禁。未列入的 runtime 必须保持缺口记录，不得把范围覆盖写成全仓库覆盖。
- `pnpm check`：在 Node 22.13+ <23 下串行运行文档、root 测试、UI lint/typecheck/test/build 和 artifact 检查。

### 验收

Node 22.23.1、pnpm 10.32.1 下 `pnpm check` 全绿；Node 版本不符时必须明确失败。不得提交 `dist`、coverage、trace、token 或临时配置。

## P1：Gateway 和 Agent Runtime

对应 TRD 01-06。确定性契约已覆盖：`tests/agent/session-lifecycle.spec.ts` 覆盖 session/turn 生命周期、连续 turn、abort reason、reload 和 runner unwind；`tests/gateway/execution-lifecycle.spec.ts` 覆盖 busy、abort 等待 stream cleanup、active replay 过滤；`tests/gateway/map-agent-event-runid.spec.ts` 覆盖 AgentEvent identity；`tests/gateway/websocket-contract.spec.ts` 覆盖 close abort 和协议错误；`tests/gateway/process-smoke.spec.ts` 覆盖本地进程入口；`tests/agent/loop/core-lifecycle.spec.ts` 覆盖文本、tool loop、model error 和 pre-abort；`tests/session/*title*` 覆盖 title 请求与并发保护。它们已加入 root unit 或 `test:contract`，证据仍按契约分别记录。

本批已补充 hello/auth 后的非法 frame、未知 method、能力缺失结构化错误、session runtime reload 状态保留、title provider 隔离、title 并发/人工覆盖保护、AgentLoop 正常文本/tool loop/pre-abort/model error，以及 GatewayServer 本地进程的 health/auth/WebSocket/端口释放 smoke；`gateway-bridge-boundaries.spec.ts` 还覆盖 permission/elicitation bus、reload response parser、隔离 token、probe 超时和连接失败短路。当前完整覆盖率运行 608 个测试，`AgentLoop.ts` 为 89.03% 行、79.03% 分支、85.21% 函数；仍缺深层 scheduler/持久化/协议恢复路径的入口或 mutation 证据。TurnRunner 也验证了 artifact collector 启动失败和 transcript accepted-input 失败不影响终态建模。`pnpm test:p1-proof` 对重复终态、人工标题优先、Gateway 错误 code 和 tool identity 执行独立反向 mutation；剩余重点是完整历史 parent proof 和更广泛的 event keyless fixture。

## P2：Context、Compaction 和四协议模型

对应 TRD 07-19。补充预算边界、projection 深拷贝、full/rolling/micro compaction、prompt overflow recovery、memory/attachment 隔离、canonical protocol 和四协议 stream fixture。纯协议、schema 和预算纯函数目标 100% coverage；真实 provider 仅进 nightly。

## P3：Router、Tool、Permission 和扩展

对应 TRD 20-34。补充 sticky/override、Token Saver mock judge、orchestration、空 allowlist、fallback、zero-usage retry、tool registry/schema/filter/scheduler/result、permission precedence、hook、plugin、skill 和 MCP reload。安全优先级、空集合、fallback 隐藏失败和 reload 保留旧 snapshot 必须有 mutation proof。

## P4：Session、文件和自动化

对应 TRD 35-41。补充 transcript 损坏/重复、title 重试和并发保护、FileHistory rollback/eviction、Windows path、Always-On lease/safety/apply、Cron delete race/timezone、多实例 store，以及 BackgroundTask output/wait/stop/cleanup。使用临时目录、path.win32、fake child 和 fake clock，不运行真实平台命令。

## P5：Adapter、Web、UI 和本地入口

对应 TRD 42-50。先覆盖公共 adapter helper、renderer 和 session mapper，再用 Feishu webhook、Weixin poll、Signal SSE、WeCom WebSocket 和通用 Webhook 验证公开 `start/stop` wiring。补充 Web API、Bridge、UI reducer、queued force-send、CLI、配置 reload、network timer 和 telemetry queue。真实账号和公网服务仍为 `DEFER_EXTERNAL`。

## P6：构建产物、浏览器和 External Nightly

构建产物 smoke 验证 dist CLI/Gateway/provider/plugin 入口、package exports 和端口释放。Browser Smoke 使用假 provider、随机端口和隔离 `PILOT_HOME`，覆盖创建 session、发送、Stop、queued send、permission、重连、跨 session 隔离和 history/live 一致。External Nightly 使用 OpenAI、Anthropic、Google × model protocol、agent/context/web、router classify、WCB/Docker 矩阵；缺少 secret 明确失败，不进入普通 PR required gate。

## 质量阈值

- canonical model、provider schema、纯函数和 UI reducer：lines/functions/branches 100%。
- Gateway、AgentLoop、Router、Tool、Session 状态机：lines/functions 95%+，branches 90%+，并有 mutation proof。
- Web、CLI、Adapter 公开入口：lines 85%+，并有 `ENTRY_SMOKE`。
- Browser Smoke、External Nightly 和真实平台不以 mock 单测覆盖率替代。

## 交付规则

每个阶段先运行定向测试，再运行 `pnpm check`；变更说明列出命令、Node/pnpm 版本、失败环境和延期项。文档、源码边界、测试映射和证据状态必须同步更新。
