# Network Request TRD

状态：评审中　维护者：Network 团队　目标读者：HTTP provider 和 CLI 维护者

## 代码边界

覆盖 `src/network/fetch.ts` 及其调用方的统一 HTTP 行为，不定义具体 provider payload。

## 核心契约

- timeout、parent abort 和请求完成之间必须正确清理 timer/listener；被 await 的 retry delay 必须保持进程存活。
- 仅幂等方法默认重试，POST 只有显式 `retryOnPost` 才可重试；retry status、Retry-After 和 backoff 必须可控。
- `content-length`、代理、TLS、DNS、连接重置、429/5xx 和非 JSON 响应必须映射为稳定错误码。
- 取消优先于超时，最终错误必须保留可诊断 cause 且不泄露凭证。

## 流程与恢复

`prepare -> fetch -> classify -> retry|return|throw`。每次 retry 创建独立 AbortController；父 signal 取消立即终止整个序列。response body 在重试前必须取消，所有 timer 在 finally 清理。

## 测试与证据

源码映射：`src/network/fetch.ts`。测试映射：`tests/network/fetch.spec.ts`、`tests/tool/builtin/pure-boundaries.spec.ts`（URL fetch 调用方的受控 transport）。覆盖 timeout、abort、retry、status、header、错误归一化、HTTP->HTTPS、缓存、重定向、二进制响应和 egress block；Node 22.23.1 下网络模块行覆盖率为 99.29%、分支覆盖率为 91.38%、函数覆盖率为 89.29%，URL fetcher 行覆盖率为 93.54%、分支覆盖率为 80.52%、函数覆盖率为 83.33%，证据状态为 `CURRENT_ONLY`。timeout 和 retry delay 的 timer 不得 `unref()`，否则待决 Promise 可能在 Node 进程退出前被取消；该行为已有当前回归测试，但尚未建立独立 mutation 证明。真实网络为 `DEFER_EXTERNAL`。CI 归属：Node deterministic gate。

## 验收与变更

验收禁止真实网络，使用 fake fetch、受控 promise 和 fake timers；任何 retry policy 或错误码变化必须同步 provider TRD。
