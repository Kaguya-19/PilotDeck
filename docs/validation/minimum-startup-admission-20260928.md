# 最小链路启动准入

本工具只闭合 runtime-6/7 暴露的启动顺序和身份库差异，不运行 Knowledge/SOP 业务，不重启旧根。历史 FAIL/raw 保留；下一候选是否获准以整合入口的 `NEXT_MINIMUM_CANDIDATE_ADMISSION.json` 为准。

使用新根中 canonical 绝对脚本路径，避免 macOS `/var` 与 `/private/var` 的 CLI guard 差异。普通进程准备清除失效的 `NODE_OPTIONS` 时仅限该子进程，不更改全局配置。

私有 startup JSON 的最小字段如下。`RUN_ROOT` 及所有值须换成本轮新隔离根的绝对路径；`environment` 沿本轮正式部署输入，不在交付文档写账户 key 或 token。每阶段使用不同 `readinessReceiptPath`/`failureReceiptPath`，原件不可覆盖。

```json
{
  "stateRoot": "/RUN_ROOT/state",
  "pilotdeckAuthDatabasePath": "/RUN_ROOT/state/pilot-home/auth.db",
  "pilotdeckHome": "/RUN_ROOT/state/pilot-home",
  "harnessRoot": "/RUN_ROOT/harness",
  "preparedBindingsPath": "/RUN_ROOT/state/prepared-bindings.json",
  "profilePath": "/RUN_ROOT/state/enabled-profile.json",
  "readinessReceiptPath": "/RUN_ROOT/state/sd-enabled-preparation.json",
  "failureReceiptPath": "/RUN_ROOT/state/sd-enabled-first-rejection.json",
  "environment": {}
}
```

运行形式：`node <canonical-PD>/scripts/run-minimum-staffdeck-startup.mjs <private-startup.json> <stage> -- <owner-command> <args...>`。工具传递校验后的 env，前置失败时不启动命令。stage 为 `pd-bootstrap`、`sd-bootstrap`、`pd-enabled`、`sd-enabled`。

1. 先完成 locked 安装及 Harness `pnpm build:lib`，成功后检查 `apps/cli/lib/bin.js`。SD 两阶段在该产物缺失时均拒启动。PD/SD 原构建命令和固定 Harness/portable refs 不变。
2. 首次 `pd-bootstrap` 写本轮 `minimum-pd-auth-root.json`，记唯一 `DATABASE_PATH` 和 `PILOT_HOME`。PD Web 原配置解析会先用`webui.runtime.databasePath`（或`customEnv.DATABASE_PATH`），默认是`PILOT_HOME/auth.db`，再加载db.js；仅传环境`DATABASE_PATH`不能覆盖这个解析。工具核profile解析路径与声明一致，bootstrap/enabled均用实际同一库。发现第二库或不同home即拒绝，不创建替代库、不删库、不关认证。bootstrap清除继承的`PILOTDECK_CONFIG_PATH`；若需独立bootstrap配置，显式给`bootstrapProfilePath`（本轮stateRoot内已写出的绝对文件），不读取旧profile。第一次正常注册建立本轮用户后，后续必须正常登录同一用户，保登录和 `/me` 原响应；不要再 register，不借旧根 user/profile。
3. 启动 SD bootstrap（domain DI 关闭）与真实 portable 服务。SD `/api/health` 独立采证；portable `/healthz` 必须声明 `sop.runtime`、`sop.lifecycle/v2`、协议 `2.0`、prepare/submit。
4. 原生显式发布合法无审批启动 bundle，取本轮响应派生 bindings。使用 `await composeVerifiedLimitedStaffDeckProfile(prepared, env)` 或 canonical CLI；必须 await 成功及确认新 profile 文件写出。不要只调用纯 `composeLimitedStaffDeckProfile`。portable 与 SD API origin 分开，discovery/management 仍指 SD `/api/v1`。
5. 使用同一 `PILOTDECK_CONFIG_PATH` 完成 enabled 前端构建，再运行 `pd-enabled`。工具要求 bootstrap auth 库存在、bindings tuple 一致、profile 固定 target 正确，以及此刻 portable manifest 有效。它不注册、登录或改写 profile。
6. Gateway 按原机制生成本轮 `PILOT_HOME/server-token` 后，运行 `sd-enabled`。工具只读该 token，认证 POST `/api/module-host/describe` 和 `list_model_catalog`，要求模型 stream/解析 Port 有声明、唯一可用 canonical 默认模型等于 profile `agent.model`。principal 来自 verified bindings，不接受替代 env。非2xx保原 status/body（含原 code/detail/request_id）；token 不写证据、不 mint、不复制。通过后才传 `PILOTDECK_DOMAIN_HOST_ENABLED=true` 给 SD 原启动入口，其 `bind_pilotdeck_domain_client` 固定 tuple 守卫保持。
7. preparation receipt 只证命令启动前的上述读取；始终 `candidateReady:false`。它不证 SD 进程已启动、真实模型 stream 或领域 DI 成功。准入仍须新进程的真实 stream、fixed SD DI 响应、selected Port/profile 证据和 SD health/auth 原件。收齐由唯一整合入口更新准入后，才通知独立验收另起新隔离根；runtime-6/7 保持封存。

公开 owner 的 [portable/profile supplement](runtime6-runtime7-public-handoff-20260928.md) 及 [聚焦协议原件](runtime6-runtime7-profile-focused-evidence-20260928.json) 已接收：短时真实 portable manifest/prepare/submit 200、verified CLI 写出成功，进程已停，身份/模型为 fixture。其结果不证明部署 Gateway、DI 或业务 PASS。

聚焦检查：`node --test scripts/run-minimum-staffdeck-startup.test.mjs scripts/compose-limited-staffdeck-profile.test.mjs scripts/prepare-staffdeck-bindings.test.mjs`。其中本地 HTTP server 是受控测试器，不是部署 Gateway/模型业务。审批/高级管理延期与员工/team排除保持；不 push/merge/deploy/archive。
