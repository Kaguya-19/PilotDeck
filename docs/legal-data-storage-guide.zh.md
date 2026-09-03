# Legal 数据存储启用指南

本文面向负责本机部署或沙盒部署的工程师，说明如何在正式 `pilotdeck server` 启用需求一、二的本地存储链路。

启用后，PilotDeck 会保存：

- 每次真实 provider LLM attempt 的 request/response 原文（JSONL）；
- 每轮执行前的 `pre_user` workspace 全量快照；
- agent 报错、超时、用户中断或 Gateway 异常轮次的 `post_agent` 全量快照；
- 快照文件通过 MD5 内容寻址复用，相同内容不会重复保存对象。

未设置 `PILOTDECK_LEGAL_STORAGE_ROOT` 时，以上采集不会启用，现有运行行为不变。

## 1. 前置条件

1. 使用 Node.js 22.x。项目要求 `>=22.13.0 <23`。
2. 准备一个 PilotDeck 项目目录和可读写的私有存储目录。
3. 私有存储目录应由宿主或部署系统挂载到沙盒可访问的位置，不要让用户消息决定该路径。
4. 准备模型 provider 配置。API key 通过环境变量注入，不要写入仓库或配置文件。

## 2. 设置环境变量

下面是最小配置。`/private/pilotdeck/legal-data` 只是示例路径，请替换成部署系统实际挂载的私有路径。

```bash
export PILOTDECK_LEGAL_STORAGE_ROOT=/private/pilotdeck/legal-data
export PILOTDECK_LEGAL_STORAGE_CONFIG_VERSION=local-v1
```

其中：

| 环境变量 | 必填 | 说明 |
|---|---:|---|
| `PILOTDECK_LEGAL_STORAGE_ROOT` | 是 | 启用本地 JSONL 和快照存储的根路径。 |
| `PILOTDECK_LEGAL_SNAPSHOT_ROOT` | 否 | 快照根路径；未设置时使用 `PILOTDECK_LEGAL_STORAGE_ROOT`。 |
| `PILOTDECK_LEGAL_STORAGE_CONFIG_VERSION` | 否 | 配置版本，默认是 `env`。建议每次切换存储目标时递增或改名。 |
| `PILOTDECK_LEGAL_DATABASE_URL` | 否 | 透传给宿主适配器；本地 JSONL 实现不会连接数据库。 |
| `PILOTDECK_LEGAL_DATABASE_SCHEMA` | 否 | 数据库 schema，供宿主适配器使用。 |
| `PILOTDECK_LEGAL_DATABASE_TABLE` | 否 | 数据库 table，供宿主适配器使用。 |

如果 JSONL 和快照需要分别放在两个挂载点，可以这样配置：

```bash
export PILOTDECK_LEGAL_STORAGE_ROOT=/private/pilotdeck/invocations
export PILOTDECK_LEGAL_SNAPSHOT_ROOT=/private/pilotdeck/workspace-snapshots
export PILOTDECK_LEGAL_STORAGE_CONFIG_VERSION=local-v2
```

## 3. 启动正式 server

在项目根目录执行：

```bash
pnpm server
```

存储初始化集中在 `createLocalGateway()`，`pilotdeck server` 只负责按现有流程启动 Gateway。设置好环境变量后，不需要额外运行初始化脚本。

如果使用已经构建好的产物：

```bash
pnpm server:built
```

workspace ID 不需要通过环境变量设置。Gateway 会根据本轮 `projectKey` 解析 PilotDeck workspace 对应的 project storage ID；这个 ID 与 `PILOT_HOME/projects/<project-id>` 使用同一套规则。客户端消息中的 `workspaceId` 不参与存储分区。

### Bash 启动脚本示例

可以将下面内容保存为项目中的 `scripts/start-legal-storage.sh`，并在启动前通过 secret manager 或当前 shell 注入模型密钥：

```bash
#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

: "${PILOTDECK_MODEL_API_KEY:?请先设置 PILOTDECK_MODEL_API_KEY}"

export PILOT_HOME="${PILOT_HOME:-$HOME/.pilotdeck}"
export PILOTDECK_LEGAL_STORAGE_ROOT="${PILOTDECK_LEGAL_STORAGE_ROOT:-$PILOT_HOME/legal-data}"
export PILOTDECK_LEGAL_SNAPSHOT_ROOT="${PILOTDECK_LEGAL_SNAPSHOT_ROOT:-$PILOTDECK_LEGAL_STORAGE_ROOT}"
export PILOTDECK_LEGAL_STORAGE_CONFIG_VERSION="${PILOTDECK_LEGAL_STORAGE_CONFIG_VERSION:-local-v1}"

mkdir -p "$PILOTDECK_LEGAL_STORAGE_ROOT" "$PILOTDECK_LEGAL_SNAPSHOT_ROOT"
cd "$PROJECT_ROOT"
exec pnpm server
```

启动前执行：

```bash
export PILOTDECK_MODEL_API_KEY='your-secret-value'
bash scripts/start-legal-storage.sh
```

脚本不会设置或覆盖 workspace ID。当前请求对应的 PilotDeck workspace 会由 Gateway 根据 `projectKey` 解析；如需使用不同的私有挂载目录，在执行脚本前设置 `PILOTDECK_LEGAL_STORAGE_ROOT` 或 `PILOTDECK_LEGAL_SNAPSHOT_ROOT` 即可。

## 4. 产物位置

假设：

```text
PILOTDECK_LEGAL_STORAGE_ROOT=/private/pilotdeck/legal-data
PilotDeck workspace project-id=legal-local
sessionKey=case-session-001
```

LLM 调用日志位于：

```text
/private/pilotdeck/legal-data/workspaces/legal-local/sessions/case-session-001/llm/invocations.jsonl
```

若未设置独立的 snapshot root，快照位于：

```text
/private/pilotdeck/legal-data/objects/md5/<前两位>/<接下来两位>/<md5>
/private/pilotdeck/legal-data/workspaces/legal-local/sessions/case-session-001/snapshots/<snapshot_id>/manifest.json
/private/pilotdeck/legal-data/workspaces/legal-local/sessions/case-session-001/snapshots/<snapshot_id>/_COMMITTED
```

只有同时存在 `manifest.json` 和 `_COMMITTED` 的快照才视为已提交。manifest 是 workspace 全量文件清单；普通文件引用 MD5 对象，符号链接记录为 symlink，不跟随到 workspace 外部。

## 5. 触发和预期结果

每次 `submit_turn` 的附件 staging 完成后，会先生成一次 `pre_user`，然后才启动 agent。

- 正常收到 `turn_completed` 且 `finishReason=completed`：只有 `pre_user`。
- agent/provider error：生成一次 `post_agent`。
- Gateway timeout：生成一次 `post_agent`。
- 用户中断：等待已有 abort/tool unwind 后生成一次 `post_agent`。
- 子 agent：不单独生成 workspace 快照；子 agent 的文件修改包含在主 turn 的异常 `post_agent` 中。
- provider retry、fallback、stream continuation：只增加 invocation attempt 日志，不增加快照。

主 agent 的日志使用主 `sessionKey`；subagent 使用独立的 subagent session ID，并通过 `subSessionId`、`parentToolCallId` 与父调用关联。客户端提交的 `workspaceId` 不会覆盖宿主配置的 workspace ID。

## 6. 故障排查

### 启动立即失败

确认 `PILOTDECK_LEGAL_STORAGE_ROOT` 已传给正式 server 进程，并确认当前 PilotDeck workspace 已注册且对应项目目录可访问。再确认存储根目录的父目录存在且当前运行用户有创建目录和写文件权限。

### 没有生成日志或快照

确认 server 进程实际继承了环境变量，而不是只在另一个终端设置。检查 workspace ID 是否为宿主配置值，并确认请求使用的是正式 `pilotdeck server` Gateway。

### 只有 pending 文件，没有最终 JSONL 记录

`.pending` 用于 request staging。模型调用结束后会追加最终 attempt 记录；如果进程在调用中退出，pending 文件可作为未完成 attempt 的排查线索，不应手工改写成成功记录。

### Node 原生依赖 ABI 错误

确保构建、启动和依赖安装使用同一个 Node 22.x 版本。切换 Node 主版本后，应在该版本下重新安装或 rebuild 原生依赖，再启动 server。

## 7. 安全要求

- 私有根路径只能来自部署环境或宿主配置，不能来自用户消息、project key 或 cwd 推断。
- API key 只能通过 secret manager 或进程环境变量注入。
- 不要把 `PILOTDECK_LEGAL_DATABASE_URL`、模型 key 或含敏感内容的 JSONL 加入版本库。
- 生产环境应限制私有存储目录的读权限，并按业务数据保留策略清理历史对象。
