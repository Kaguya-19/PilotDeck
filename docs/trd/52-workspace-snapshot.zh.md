# Workspace Snapshot Storage TRD

状态：评审中　维护者：Platform / Agent Runtime 团队　版本：v1

## 1. 背景与范围

本 TRD 定义 Legal 线上数据采集中的 workspace 快照存储。线上 Agent 在沙盒内运行，快照正文写入由部署方挂载、但不属于沙盒生命周期的私有目录；沙盒进程可以访问该目录。快照采用“全量 manifest + MD5 内容对象”模型，不把每轮 workspace 复制成一份独立的物理目录。

本次需求二的行为调整为：

- 每轮用户输入前生成 `pre_user` 快照。
- Agent 正常完成的轮次不生成 `post_agent` 快照。
- Agent 报错、超时、用户中断，以及 Gateway/进程异常导致轮次没有正常终态时，生成一次 `post_agent` 快照。

本 TRD 不定义 LLM request/response 日志、OBS 读权限白名单、评测流量标识和数据保留期限；这些属于其他需求或平台部署文档。

### 1.1 存储目标与身份配置

快照的数据库、正文对象和逻辑归属均由配置与运行时上下文决定，不允许在代码中写死：

| 配置/上下文 | 类型 | 说明 |
|---|---|---|
| `database.url` | secret/reference | 快照 manifest/文件记录数据库地址，通过 secret/config provider 注入，不写入 manifest。 |
| `database.schema` / `database.table` | string | 快照级和文件级记录的目标表，由部署配置显式指定。 |
| `snapshotStore.root` | string | 沙盒外私有根路径；沙盒仅通过挂载访问，不能由用户请求覆盖。 |
| `snapshotStore.objectPrefix` | string | 对象和 manifest 的可配置前缀；实际 key 仍由受校验的 ID/MD5 生成。 |
| `workspace_id` | string | 逻辑 workspace 标识，由 Gateway 根据 PilotDeck 当前 workspace/project 解析；不能用 `workspaceDir` 或用户消息推断。 |
| `session_id` | string | 当前 session 标识，由运行时注入；每个快照必须明确归属。 |

部署可通过环境变量、配置文件或配置中心提供上述目标配置，具体优先级和热更新规则由平台统一定义。启动时校验数据库地址、私有根路径可访问且可写；运行时缺少 `workspace_id` 或 `session_id` 时拒绝生成“成功快照”，不得退回默认 workspace/session。快照记录 `storage_config_version`，保证配置切换后仍可定位原存储目标。

## 2. 目标与非目标

### 2.1 目标

- 能还原异常轮次结束时 workspace 内的文件内容和路径。
- 同一文件内容在不同轮次、不同 session 间只保存一份正文。
- 同一 workspace 连续多轮未变化时，新增成本主要是 manifest，而不是重复复制文件。
- 私有目录挂载、上传失败、进程重启和重复收尾不会产生不可读或半成品快照。
- 快照必须绑定 `session_id`、`turn_id`、`run_id` 和轮次阶段，旧 run 不能覆盖新 run。

### 2.2 非目标

- 不使用快照替代 Agent transcript 或 LLM 调用日志。
- 不在 v1 依赖 Btrfs、ZFS、LVM 或 OverlayFS 的宿主机特权。
- 不为成功轮次保存 `post_agent`，也不为每次内部 retry 单独创建 workspace 快照。

## 3. 设计原则

1. **Gateway 是终态事实来源**：快照触发必须基于已确认的 turn/run 终态；UI、runner 的推测状态不能单独触发成功快照。
2. **manifest 全量、正文去重**：每份 manifest 描述该时刻的完整文件集合；正文以 MD5 内容对象保存并复用。
3. **对象不可变**：对象一旦以 MD5 写入，不允许覆盖；历史 manifest 引用的对象永久有效，直到明确的数据保留策略处理。
4. **阶段幂等**：相同 `(session_id, turn_id, phase)` 的重试只得到一份逻辑快照。
5. **先临时、后提交**：所有文件和 manifest 先写入临时位置，完成校验后原子提交；消费者只读取已提交快照。
6. **沙盒路径不外泄**：manifest 使用 workspace 相对路径；私有目录路径、宿主机路径和用户输入不能直接拼接为对象路径。

## 4. 概念与状态

### 4.1 快照阶段

| phase | 触发时机 | 是否必须 | round_status |
| --- | --- | ---: | --- |
| `pre_user` | 本轮用户消息落库、Agent 执行前 | 是，包括首轮 | `captured` |
| `post_agent` | 本轮异常收尾完成后 | 仅异常轮次 | `failed` 或 `aborted` |

成功轮次只留下 `pre_user`。下一轮的 `pre_user` 反映成功轮次结束后、下一条用户消息进入前的 workspace 状态。

### 4.2 异常分类

必须生成 `post_agent` 的异常包括：

- Agent/model error；
- Agent turn timeout；
- 用户主动中断；
- Gateway/WS/进程异常导致没有收到正常 `turn_completed`；
- 其他被 Gateway 标记为非成功终态的 turn。

内部 provider retry 或 fallback 不单独生成快照。若 retry 最终成功，不生成 `post_agent`；若最终失败，只按最终逻辑 turn 生成一次。

### 4.3 快照状态机

```text
pending -> capturing -> committed
                    \-> failed
```

`committed` 才能被下载或用于恢复。`failed` 记录失败原因和已完成的对象数量，但不能被当作完整快照读取。

## 5. 存储模型

### 5.1 快照级记录

```text
snapshot_id          UUID
workspace_id         string
session_id           string
turn_id              string
run_id               string
round_number         integer
phase                pre_user | post_agent
round_status         captured | failed | aborted
failure_reason       string nullable
is_distil            boolean
sandbox_image        string nullable
deps_lock_md5        string nullable
workspace_root_id    string
storage_config_version string
exclusion_policy     JSON
state                pending | capturing | committed | failed
created_at           timestamp
committed_at         timestamp nullable
```

`(session_id, turn_id, phase)` 是唯一幂等键。`run_id` 用于追踪具体执行实例，但不作为快照唯一键，因为同一逻辑 turn 可能经历 retry 或异常收尾重试。

### 5.2 文件级记录

```text
snapshot_id
path                 workspace-relative POSIX path
entry_type           file | symlink | excluded
size                 integer
md5                  string nullable
mtime                timestamp nullable
object_key           string nullable
exclusion_reason     string nullable
```

普通文件必须有 `size`、`md5` 和 `object_key`。v1 默认不跟随 workspace 外部的 symlink；symlink 或被配置排除的条目必须通过 `entry_type` 和 `exclusion_reason` 显式记录，不能静默消失。

### 5.3 私有目录布局

由 `snapshotStore.root` 配置解析出的私有根目录记为 `${SNAPSHOT_ROOT}`，不允许由请求参数提供：

```text
${SNAPSHOT_ROOT}/
  objects/md5/<first-2>/<next-2>/<md5>
  workspaces/<workspace_id>/
    sessions/<session_id>/
      snapshots/<snapshot_id>/manifest.json
      snapshots/<snapshot_id>/_COMMITTED
    locks/<turn_id>.lock
```

对象 key 只由受校验的 MD5 生成。`workspace_id`、session、turn 和 snapshot 目录名使用受限字符集或 UUID，禁止 `..`、路径分隔符和符号链接逃逸。`workspace_id` 和 `session_id` 只作为已校验的逻辑分区键，不得直接拼接用户输入。

## 6. 采集流程

### 6.1 `pre_user`

```text
接收新 turn
  -> staging/附件写入 workspace 完成
  -> 在 Agent 执行前创建 pre_user pending 记录
  -> 遍历 workspace 全部条目
  -> 对每个普通文件流式计算 MD5
  -> 缺失对象写入临时文件并原子 rename
  -> 写完整 manifest 和文件记录
  -> 写 _COMMITTED
  -> 允许 Agent 开始执行
```

如果 pre_user 采集失败，不能静默继续并声称已采集；应记录明确错误并按产品策略阻止该轮或标记数据缺失。

### 6.2 异常 `post_agent`

```text
Gateway 确认异常终态
  -> 等待主 Agent、子 Agent 和工具写入全部 unwind
  -> 获取该 turn 的 workspace 写入锁
  -> 创建 post_agent pending 记录
  -> 遍历当前 workspace 并复用已有 MD5 对象
  -> 写完整 manifest、_COMMITTED 和异常原因
  -> 持久化 run result / 清理 sandbox
```

timeout 和用户中断必须先完成 abort/close 的收尾，再进行扫描；不能在 abort 信号刚发出时直接读取仍可能变化的 workspace。对于没有 `turn_completed` 的连接断开或进程异常，必须在 runner/server 的 `finally` 中走同一收尾函数。

### 6.3 对象写入

对象写入采用内容寻址和原子提交：

1. 以流式方式读取文件，避免将整个文件加载到内存。
2. 写入 `${SNAPSHOT_ROOT}/objects/.tmp/<uuid>`。
3. 完成后校验计算出的 MD5 与目标 key 一致。
4. 使用 exclusive create 或原子 rename 提交到 MD5 key；已存在时丢弃临时对象并复用已有对象。
5. 只有对象提交成功后，manifest 才能引用该对象。

## 7. 与现有运行时的集成边界

新增独立的 `WorkspaceSnapshotRecorder`，不复用当前用于生成文件检测的 `_snapshot_tree()`。

建议接口：

```text
capturePreUser(input: {
  workspaceId, sessionId, turnId, runId, roundNumber, workspaceDir,
  storageConfig, metadata
}): Promise<SnapshotResult>

capturePostAgent(input: {
  workspaceId, sessionId, turnId, runId, roundNumber, workspaceDir,
  storageConfig, terminal: "failed" | "aborted", failureReason, metadata
}): Promise<SnapshotResult>
```

集成点：

- Gateway/`TurnRunner` 提供稳定的 `workspace_id`、`session_id`、`turn_id` 和终态；recorder 使用已解析的 database/snapshot store 配置快照。
- Python runner/server 的 sync 与 streaming 路径共用同一个 round finalizer。
- `run_id` 只作为执行追踪字段，不改变快照幂等键。
- 子 agent 不创建 workspace 阶段快照；其文件变化包含在所属主 turn 的 post_agent 快照中。子 agent 的 LLM 日志另按需求一处理。

## 8. 一致性、并发与恢复

- 同一 session 同时最多一个 active turn；recorder 仍需校验 turn/run identity，迟到的旧 run 不得提交新 turn 的快照。
- manifest 写入采用临时文件 + 原子 rename；`_COMMITTED` 是消费者可见性的最终标记。
- 进程在对象上传中重启时，启动清理任务只能删除无引用、超过安全窗口的 `.tmp` 文件，不能删除已提交对象。
- 数据库记录与文件系统提交不可能使用同一事务时，以 `_COMMITTED` 和 manifest 可读性作为文件侧事实；后台 reconciliation 负责补齐数据库状态。
- `committed` 快照缺失任一 manifest 引用对象时必须报警并标记不可恢复，不能返回部分 workspace。
- snapshot recorder 失败不得覆盖或删除上一份已提交快照。

## 9. 性能与容量

- 文件正文按固定块流式读取，单文件内存上限不随文件大小增长。
- v1 每轮仍扫描全量目录，以保证 manifest 完整；MD5 对象上传只发生在新内容出现时。
- 后续可增加 inode/mtime/size 缓存或 inotify/fanotify 加速，但任何增量索引都必须支持定期全量校验，不能作为唯一事实来源。
- 监控 `scan_duration_ms`、`files_count`、`new_objects_count`、`bytes_scanned`、`bytes_uploaded`、`dedup_ratio`、`snapshot_failure_count` 和 pending 时长。

## 10. 测试与验收

必须覆盖以下确定性场景：

- 空 workspace 和首轮 `pre_user` 生成 0 条文件记录。
- 普通文件、新增文件、覆盖文件、删除文件和嵌套目录的全量 manifest。
- 相同内容跨轮次只产生一个 MD5 对象。
- `pre_user` 成功轮次不生成 `post_agent`。
- Agent error、timeout、用户中断分别生成一次 `post_agent`，并正确写入 `round_status` 和 `failure_reason`。
- provider retry/fallback 不重复生成快照；最终成功和最终失败行为分别正确。
- 不同 `workspace_id`/`session_id` 的快照目录和 manifest 互相隔离；配置切换后历史快照仍可定位。
- stream disconnect、Gateway 异常和无 `turn_completed` 的 finally 路径仍能生成异常快照。
- 对象上传失败、manifest 写失败、私有目录不可写时，状态为 `failed`，且上一份有效快照仍可读取。
- 并发重复 finalize 只得到一份 `(session_id, turn_id, phase)` 快照。
- 旧 run 的迟到收尾不能覆盖新 turn 的 snapshot。
- symlink、排除目录和路径穿越都按 exclusion policy 明确记录或拒绝。
- 通过 manifest 逐文件读取对象，能够在新目录还原完整 workspace。

测试证据按项目规范记录为 `CURRENT_ONLY`、`PARENT_FAIL` 或 `MUTATION_FAIL`，不得用删除或跳过失败测试换取全绿。

## 11. 部署与灰度

第一阶段仅在本地使用一个可写私有目录验证 recorder、对象去重和异常终态；第二阶段在测试集群挂载私有路径，验证沙盒重启、磁盘配额和权限；第三阶段再接入线上版本。

部署必须提供：

- `database.url`、目标 schema/table 和 `${SNAPSHOT_ROOT}`（由 `snapshotStore.root` 解析）的固定配置与可写权限；
- `workspace_id` 的来源及 session/turn/run 上下文透传；
- 私有根目录的容量/配额监控；
- 临时对象清理任务；
- reconciliation 和失败告警；
- snapshot schema 版本号，便于后续字段演进。

不允许把宿主机根目录或用户可控路径直接挂载给 Agent；挂载范围应限制为专用 snapshot 子目录。

## 12. 待确认项

- 私有路径由容器 volume、宿主机 bind mount 还是 sidecar 提供。
- 线上单个 session、单个文件和单个 snapshot 的容量上限。
- snapshot 正文是否同时异步复制到 OBS，以及复制完成前的可见性要求。
- `is_distil`、`sandbox_image` 和 `deps_lock_md5` 的生产字段来源。
- 失败快照的保留期、删除审批和恢复接口。
- 数据库地址、表名、私有根路径和对象前缀的配置来源、热更新边界及配置版本记录方式。
