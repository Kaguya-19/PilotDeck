# PilotDeck AgentLoop 对拍工具

这是 PilotDeck 仓库内的 PilotDeck-only 对拍工具，只比较当前（或指定 baseline）的 native 与 sidecar AgentLoop。它不包含 StaffDeck Harness、TaskFrame、SOP、lease、fencing 或其他宿主状态机。

## 目录

- `run.py`：只运行 PilotDeck pair 的 orchestrator；
- `scenarios.json`：共享确定性场景 fixture，runner 只选择 `pairs` 含 `pilotdeck` 的场景；
- `mock_backend.py`：确定性 mock model/tool provider；
- `trace.py`：canonical trace、oracle 和语义比较器；
- `adapters/`：PilotDeck native、sidecar 和 gateway adapter。

StaffDeck fork 仍维护跨宿主 orchestrator、StaffDeck adapter 和真实 Harness 对拍。两边的 PilotDeck adapter 应保持协议和 trace 契约一致，但不复制宿主业务代码。

## 运行

在 PilotDeck 仓库根目录完成 Node 22 构建后，从本目录运行：

```bash
source ~/.nvm/nvm.sh
nvm use 22
pnpm build

python tools/agent-loop-parity/run.py \
  --pilotdeck-root "$PWD" \
  --comparison same-version \
  --surface gateway \
  --scenario all \
  --output /tmp/pilotdeck-agent-loop-parity
```

对照 `origin/main` 的产品版本漂移：

```bash
python tools/agent-loop-parity/run.py \
  --pilotdeck-root "$PWD" \
  --pilotdeck-baseline origin/main \
  --comparison both \
  --surface gateway \
  --scenario all \
  --output /tmp/pilotdeck-agent-loop-parity-baseline
```

`same-version` 是 sidecar parity gate；`baseline`/`both` 的 baseline drift 单独报告，不计入 sidecar 语义结论。缺少 Node、构建产物、adapter 入口、依赖或 trace 时返回 `BLOCKED`，不合成成功结果。

Gateway sidecar adapter 必须设置 `PILOTDECK_AGENT_LOOP_TRANSPORT=stdio` 并进入正式 deployment profile 和
`createAgentLoopSidecarRuntimeFactory`。trace 中必须存在 transport selection、sidecar handshake/binding，以及场景
声明的 host module-call 证据；缺失时 runner 直接分类为 `BLOCKED`。禁止通过自建 runner 或
`__testAgentLoopFactory` 绕过生产 factory。当前完整 gate 为 52 个场景，其中包含 host-owned plan-mode 四 turn、budget、
elicitation、live steer、durable compaction、完整及 projected-request compaction budget、sidecar seed read state、live
model streaming、model metadata、empty SDK system prompt 和 additional working directories。production proof
记录 module 与 operation；例如增量流场景必须实际出现 `model.stream_next`，只有 `model` 模块名不足以通过 oracle。

## 比较和验收

比较规则以 [PilotDeck Native / Sidecar 对拍 SOP](../../docs/pilotdeck-agent-loop-parity-sop.zh.md) 和 [Module Communication SOP](../../docs/pilotdeck-module-communication-sop.zh.md) 为准。只忽略随机身份、时间戳、transport envelope 和 canonical image block 的派生 `bytes`；消息、图片 MIME/data、tool、permission、checkpoint、终态、错误码和用户输出必须严格比较。

退出码：`0` 表示通过，`1` 表示 oracle 或语义差异，`2` 表示环境或 adapter 阻塞。trace、日志、SQLite 和 mock 记录应输出到临时目录，不提交到 Git。

mock model/tool 只作为正式 host dispatcher 的确定性依赖，不代表真实 provider 或完整 deployment E2E。修改
production proof 时必须同时运行 harness negative-control：fake runner 或缺少 handshake 证据必须得到 `BLOCKED`。
