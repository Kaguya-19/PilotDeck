# PilotDeck AgentLoop 对拍结果

## 范围

本次实验只比较同一 PilotDeck checkout 中的 native 与 Module Protocol sidecar 两条 AgentLoop 链路。测试入口为真实 Gateway、WebSocket session、ContextRuntime、ToolRuntime、PermissionRuntime 和 sidecar 进程；模型和工具边界使用确定性本地 mock，不访问真实 provider，也不使用真实 API key。

执行 checkout：`/Users/a1/Desktop/claw/openbmb/PilotDeck-core_agent_loop_0831`

环境：Node `v22.22.0`，pnpm `10.32.1`，Python `3.12`。

## 命令和结果

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 构建 | `pnpm build` | PASS |
| Modular/session focused tests | `node --test dist/tests/agent/modules/*.js dist/tests/agent/session/agent-loop-factory.spec.js` | 23 passed |
| TypeScript 静态检查 | `npx tsc --noEmit -p tsconfig.json` | PASS |
| Gateway core-regression | `run.py --comparison same-version --surface gateway --suite core-regression` | 10/10，零 semantic diff |
| Gateway core-resilience | `run.py --comparison same-version --surface gateway --suite core-resilience` | 20/20，零 semantic diff |
| Gateway 全量 PilotDeck 场景 | `run.py --comparison same-version --surface gateway --scenario all` | 31 场景，零未声明差异 |
| Gateway known-gap | `run.py --comparison same-version --surface gateway --suite known-gap` | 1 场景按声明复现 |

全量命令：

```bash
source ~/.nvm/nvm.sh
nvm use 22.22.0
python tools/agent-loop-parity/run.py \
  --pilotdeck-root /Users/a1/Desktop/claw/openbmb/PilotDeck-core_agent_loop_0831 \
  --comparison same-version \
  --surface gateway \
  --scenario all \
  --output /tmp/pd-all
```

全量摘要：

```json
{
  "scenarios": 31,
  "blocked": [],
  "failed": [],
  "oracleFailures": [],
  "knownGaps": ["auto_compact/PilotDeck: reproduced 16 expected difference(s)"],
  "formatWarnings": ["auto_compact/PilotDeck: 18 warning(s)"]
}
```

## 结论

| 类别 | 结论 |
| --- | --- |
| 已确认对齐 | 纯文本、单/多工具、权限 allow/deny、图片输入、错误分类、取消、deadline、工具并发和 seed state 场景均通过 oracle 与 native/sidecar 语义比较。 |
| 已声明差异 | `auto_compact` 属于当前 sidecar 未代理 `tryAutoCompact` 的 known-gap，稳定复现 16 项预期差异；不计入 sidecar parity 失败，但不能标记为零差异。 |
| 未发现 | 本轮没有 BLOCKED、oracle failure 或未声明 semantic diff。 |
| 不在范围 | StaffDeck Harness/TaskFrame/SOP/lease/fencing 及跨宿主对拍继续由 StaffDeck 仓库维护。 |

图片比较只忽略 canonical image block 的派生 `bytes` 字段，MIME、base64 data、消息分组和顺序仍严格比较。mock、trace 和临时运行目录均位于 `/tmp`，不进入 Git。

## 可复现性

每个 suite 建议连续运行两次，并比较 canonical trace。若出现差异，先检查 BLOCKED 和 fixture oracle，再定位最早 semantic event；不得通过扩大 normalization 或只比较最终回答来隐藏分叉。
