# UI Interaction PRD/TRD

状态：评审中　维护者：产品与 UI 团队　目标读者：产品、前端和验收维护者

## 代码边界

描述 `ui/src/components/chat/**`、`ui/src/components/chat-v2/**` 的用户流程，不重新定义 Gateway 或 UI store 的内部协议。

## 核心契约

- 创建 session、发送消息、Stop、queued send、force-send、permission/elicitation、附件和重连必须给出明确的用户可见状态。
- 首次 queued 点击只入队；force-send 先尝试 abort，失败不得伪造 idle 或提交第二个 turn。
- history 与 live 最终内容必须一致，跨 session 切换不能显示另一 session 的 pending/working。
- 错误、取消、超时和重试必须保留可理解的上下文，不丢失用户输入快照。

## 流程与验收

正常流程为 `new session -> compose -> submit -> stream -> complete`；异常流程覆盖 busy、permission deny、断线重连和附件失败。用户验收用例映射到 `ui/src/components/chat/hooks/useChatComposerState.test.ts`、`useChatRealtimeHandlers.test.tsx`、`ui/src/components/chat-v2/ChatInterfaceV2.reconnect.spec.ts`。当前单测为 `CURRENT_ONLY`，完整交互为 Browser Smoke。

## 测试与变更

使用 fake timers、受控 Gateway mock 和短超时；不得通过 snapshot 自动更新掩盖行为变化。文案、流程或可见错误变化必须更新 PRD、UI reducer TRD 和 e2e 用例。
