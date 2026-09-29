# 真实 E2E 执行说明

## 环境准备

要求 Node.js 22（满足仓库 runtime check）、pnpm、Playwright 浏览器、Git、Python 3、make 和 C/C++ 编译工具。使用源码服务，不使用 Docker。

每次运行创建隔离目录：

- `PILOT_HOME`：临时配置、技能、会话、日志和快照目录；
- 临时 SQLite `DATABASE_PATH`；
- 临时 workspace 和文件 fixture；
- 独立 `SERVER_PORT`、`PILOTDECK_GATEWAY_PORT`、`VITE_PORT`。

不要复用开发者当前的 `~/.pilotdeck`、auth 数据库或工作区。

## Secret 和模型配置

凭证通过 CI secret 或当前 shell 环境变量注入。推荐变量：

```text
PILOTDECK_E2E_LLM_CENTER_URL=https://llm-center.modelbest.co
PILOTDECK_E2E_API_KEY=<secret from CI only>
PILOTDECK_E2E_OPENAI_MODEL=gpt-4.1
PILOTDECK_E2E_ANTHROPIC_MODEL=claude-sonnet-4.6
PILOTDECK_E2E_GEMINI_MODEL=gemini-2.5-flash
```

运行时为三个 provider 生成隔离配置：OpenAI 使用 `protocol: openai`，Anthropic 使用 `protocol: anthropic`，Gemini 使用 `protocol: google`。Base URL 和协议路径必须与 LLM Center 实际接口一致。文档、Git、Playwright trace、截图和服务日志不得打印 API Key。

## 启动顺序

1. 创建临时目录并写入仅含测试 provider 的配置。
2. 启动源码 supervisor：`SERVER_PORT`、`PILOTDECK_GATEWAY_PORT`、`PILOTDECK_GATEWAY_URL` 指向隔离端口。
3. 等待 UI、Express/WebSocket 和 Gateway 三个端口可连接。
4. 使用真实 Chromium 打开 UI，完成 onboarding 或加载已准备的隔离用户。
5. 执行模块套件：Onboarding、会话、文件、技能、设置。
6. 收集证据，执行 UI 清理和临时目录清理。

典型源码启动命令：

```bash
source "$HOME/.nvm/nvm.sh"
nvm use 22
SERVER_PORT=3005 \
VITE_PORT=5174 \
PILOTDECK_GATEWAY_PORT=18791 \
PILOTDECK_GATEWAY_URL=ws://127.0.0.1:18791/ws \
corepack pnpm run dev
```

在另一个 shell 中执行真实浏览器套件：

```bash
cd ui
PILOTDECK_E2E_LLM_CENTER_URL=https://llm-center.modelbest.co \
PILOTDECK_E2E_API_KEY="$PILOTDECK_E2E_API_KEY" \
corepack pnpm run e2e:real
```

首次 onboarding 套件使用独立端口和隔离运行目录：

```bash
cd ui
PILOTDECK_E2E_LLM_CENTER_URL=https://llm-center.modelbest.co \
PILOTDECK_E2E_API_KEY="$PILOTDECK_E2E_API_KEY" \
corepack pnpm run e2e:real:onboarding
```

两个命令都会由 Playwright 自动启动 `ui/server/webRuntimeSupervisor.js dev`，不需要手工启动 UI 或 Gateway。执行前必须设置真实 secret；未设置时 global setup 会明确失败。

Playwright 必须指向实际 UI URL，不得指向 `ui/e2e/fixtures`。桌面套件使用至少 `1440x900` 和 `1100x800`，另执行移动 viewport（例如 `390x844`）覆盖侧边栏、设置导航和弹窗。

## 预检和模型覆盖

正式套件前对三个模型执行真实连接预检：发送最小文本请求，确认 HTTP 成功、响应可解析、模型名匹配。预检失败分类为 `DEFER_EXTERNAL` 或环境失败，并停止对应模型套件；不得改用假响应。

会话套件至少对每个模型完成：模型选择、发送唯一标记、等待流结束、刷新、重新打开会话、核对 assistant 文本和模型信息。连接测试和 onboarding 完成流程也要覆盖三种模型。

## 失败分类与重试

- `PRODUCT_FAILURE`：按钮不可点、UI 状态错误、错误配置被写入、文件/数据库结果错误；不得自动重试掩盖问题。
- `ENV_FAILURE`：服务未启动、浏览器缺失、端口冲突、权限或临时目录错误；修复环境后重跑。
- `DEFER_EXTERNAL`：LLM Center 超时、限流、模型下线、凭证过期；保留完整请求状态和服务日志，不替换 mock。

单个用例最多一次 Playwright 重试。只有 `ENV_FAILURE` 或明确的外部瞬时错误允许重跑；删除、清空、更新、重启后不得盲目重试导致重复破坏性操作。

## 证据、清理和验收

失败时保存 trace、截图、console、网络状态摘要、服务日志、配置 revision、当前 URL 和文件系统快照。成功的破坏性用例也保留确认和最终状态摘要。

清理顺序：先通过 UI 删除会话/项目/技能和测试文件，恢复权限和配置，再停止 supervisor，最后删除临时 `PILOT_HOME`、数据库和 workspace。清理失败必须单独报告，不能默默忽略。

整套文档的验收条件是：五个模块均有执行记录；每个可见按钮至少有成功点击用例；设置矩阵全部完成；OpenAI、Claude、Gemini 三种真实模型均有聊天证据；没有 API mock、请求拦截、fixture 页面或假模型响应。
