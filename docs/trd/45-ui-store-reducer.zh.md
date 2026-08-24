# UI Store and Reducer TRD

状态：评审中　维护者：UI 团队　目标读者：React 状态和测试维护者

## 代码边界

覆盖 `ui/src/stores/useSessionStore.ts`、`ui/src/contexts/WebSocketContext.tsx`、chat hooks 和相关 reducer。服务端事实来源仍是 Gateway，UI 只维护投影和交互状态。

## 核心契约

- 每个 session slot 的 history、live、pending、working、active run 和 error 必须隔离。
- 事件按 runId/sessionKey/seq 合并；旧 run 或迟到请求不得覆盖当前 session。
- reconnect 后必须从 history/replay 恢复可见状态，不重复提交 turn；终态必须幂等。
- queued send、force send、Stop、permission 和 elicitation 状态转换必须可观察且可取消。

## 流程与恢复

`idle -> pending -> working -> completed|failed|cancelled` 是 UI 投影状态机。连接丢失进入 `reconnecting`，恢复后先重建 snapshot 再接收增量。跨 session 切换不得搬运 pending/working 状态。

## 测试与证据

源码映射：`ui/src/stores/**`、`ui/src/contexts/WebSocketContext.tsx`、`ui/src/components/chat/hooks/**`。测试映射：`ui/src/stores/useSessionStore.streaming.test.ts`、`useSessionStore.requests.spec.tsx`、`ui/src/contexts/WebSocketContext.queue.test.tsx`、chat hook tests。当前为 `CURRENT_ONLY`，queued/reconnect/隔离契约进入 mutation proof；Playwright 只作非阻塞 smoke。

## 验收与变更

验收覆盖 session 切换、重连、迟到事件、force-send、permission、失败和最终一致性。事件字段变化必须同步 44 号 Bridge TRD。
