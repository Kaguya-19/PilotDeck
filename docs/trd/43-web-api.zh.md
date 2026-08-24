# Web API TRD

状态：评审中　维护者：Web 团队　目标读者：UI、API 和安全维护者

## 代码边界

覆盖 `src/web/**`、`ui/server/routes/**`、`ui/server/middleware/auth.js` 和上传/项目/技能/命令路由。Gateway WebSocket 协议由 01 号 TRD 负责。

## 核心契约

- 每个 REST route 必须明确方法、鉴权、输入校验、响应结构、错误状态和幂等性。
- 上传、项目和 session 路径必须经过 workspace boundary 校验，不能从请求参数越界读取文件。
- SSE/长请求必须支持客户端断开和服务关闭，不能遗留 listener 或 promise。
- 认证、配置和外部 provider 错误必须返回稳定的可诊断错误，不回显 secret。

## 流程与恢复

请求依次经过 auth、参数解析、业务服务和序列化。校验失败在业务执行前返回 4xx；业务失败返回规范错误；客户端取消只清理当前请求。重复创建、重复上传和重复 webhook 由 route 或服务层按 request/idempotency key 去重。

## 测试与证据

源码映射：`ui/server/routes/**`、`src/web/server/**`。测试映射：`ui/server/routes/commands.test.js`、`config.test.js`、`uploads.test.js`、`gateway.test.js`、`tests/web/**`。当前 route 测试为 `CURRENT_ONLY`；真实浏览器和外部 provider 标记 `DEFER_EXTERNAL`。CI 归属：UI/Node deterministic gate，Browser Smoke 为非阻塞层。

## 验收与变更

验收覆盖健康检查、鉴权拒绝、参数错误、成功响应、SSE 取消、上传边界和服务关闭。API schema 或错误码变更必须同步 API 文档与契约测试。
