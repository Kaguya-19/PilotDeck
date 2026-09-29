# PilotDeck 前端真实 E2E 测试

## 目标

本目录定义 PilotDeck Web 前端的真实浏览器端到端测试。测试覆盖 Onboarding、会话、文件、技能、设置五个模块，以及这些模块中的按钮、菜单、弹窗、表单控件和确认流程。

测试必须通过真实 Playwright 浏览器访问源码启动的 PilotDeck 服务，使用真实文件系统、SQLite 和真实 LLM Center。测试不得用 mock API、`page.route`、MSW、fixture HTML、假模型响应或本地替代服务。

## 文档索引

| 文档 | 模块 |
|---|---|
| [01-onboarding.zh.md](./01-onboarding.zh.md) | 首次使用引导、Provider、工作区 |
| [02-session.zh.md](./02-session.zh.md) | 项目、会话、消息、模型和输入区 |
| [03-files.zh.md](./03-files.zh.md) | 文件树、编辑器、预览和上传 |
| [04-skills.zh.md](./04-skills.zh.md) | 技能浏览、安装、导入、创建和编辑 |
| [05-settings.zh.md](./05-settings.zh.md) | 设置页面和各子页面行为 |
| [06-settings-control-matrix.zh.md](./06-settings-control-matrix.zh.md) | 设置控件逐项矩阵 |
| [07-execution.zh.md](./07-execution.zh.md) | 环境、执行、清理和失败分类 |

## 统一用例格式

每条用例必须记录以下字段：

| 字段 | 要求 |
|---|---|
| 用例 ID | 模块前缀加递增编号，例如 `ONB-PROVIDER-001` |
| 模块 | Onboarding、会话、文件、技能或设置 |
| 前置条件 | 页面、用户、workspace、配置、模型和数据状态 |
| 操作步骤 | 使用可访问名称或稳定 label 定位，逐步点击和输入 |
| 预期结果 | UI、HTTP 响应、配置、数据库、文件系统和运行时结果 |
| 清理动作 | 删除测试数据或恢复配置；隔离环境可执行真实删除 |
| 模型覆盖 | OpenAI、Claude、Gemini 或协议无关 |
| 破坏性级别 | `普通`、`删除`、`清空`、`重置`、`更新`、`重启` |

## 真实模型矩阵

| 协议 | Provider 配置 | 模型 | endpoint 路径 |
|---|---|---|---|
| OpenAI | `protocol: openai` | `gpt-4.1` | `/v1/chat/completions` |
| Anthropic | `protocol: anthropic` | `claude-sonnet-4.6` | `/v1/messages` |
| Gemini | `protocol: google` | `gemini-2.5-flash` | `/v1beta/models/{model}:{method}` |

三种模型都必须完成一次真实连接测试和一次真实聊天。凭证只通过 CI secret 或当前 shell 的环境变量注入，不能出现在文档、源码、YAML、trace、截图或日志中。测试使用唯一文本标记，例如 `E2E-<run-id>-<provider>`，以便把浏览器消息和真实请求对应起来。

## 真实浏览器原则

- 使用 Playwright Chromium 或项目支持的真实浏览器启动，不使用 DOM-only 渲染器。
- 测试从真实 URL 进入应用，不访问 `ui/e2e/fixtures`。
- 不拦截或改写任何 `/api`、WebSocket、模型、文件、技能和配置请求。
- 通过 UI 产生数据，再通过 UI、API 只读查询和文件系统检查确认结果。
- 删除、清空、重置、更新和重启按钮在隔离环境中真实执行，并验证最终状态。
- 只有外部服务不可用、模型限流或凭证无效时才标记环境失败，不以 mock 替代。

## 证据与通过标准

每次失败必须保留 Playwright trace、失败截图、浏览器 console、服务 stdout/stderr、当前 URL、用例 ID、按钮可访问名称、模型协议和请求状态。成功用例至少断言 UI 变化和一个持久化结果。

测试通过要求：五个模块都有独立用例；每个可见按钮至少被成功点击一次；设置全部子页和控件均在矩阵中；三种模型均真实完成聊天；破坏性操作均有确认、执行和清理证据；测试代码和执行配置没有 mock 或请求拦截。
