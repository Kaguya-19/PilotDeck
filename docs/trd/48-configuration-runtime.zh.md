# Configuration and Runtime TRD

状态：评审中　维护者：Config/Runtime 团队　目标读者：配置、模型和部署维护者

## 代码边界

覆盖 `src/pilot/config/**`、`src/pilot/paths.ts`、模型/provider 配置解析和 UI 配置 reload 服务。凭证值不在文档、日志或测试输出中出现。

## 核心契约

- 配置加载必须产生带 version/diagnostics 的 snapshot；merge 顺序和默认值必须确定。
- reload 失败必须保留旧 snapshot，并提供诊断；并发 reload 合并为一个在途操作。
- provider credential、placeholder key 和 secret redaction 必须在内存边界内完成，不能写入 telemetry 或错误响应。
- `PILOT_HOME`、workspace 和 session 路径必须可显式覆盖并与真实用户 home 隔离。

## 流程与恢复

`load -> validate -> normalize -> publish`。文件 watcher 触发 debounce reload；解析失败保留旧配置，后续修复后可再次 reload。模型冲突采用软恢复或明确失败，不能半发布 snapshot。

## 测试与证据

源码映射：`src/pilot/config/**`、`src/pilot/paths.ts`、`ui/server/services/pilotdeckConfig.js`。测试映射：`tests/model/config/parseModelConfig.spec.ts`、`tests/pilot/config/config-runtime.spec.ts`、`tests/pilot/config/parseToolsConfig.spec.ts`、`tests/pilot/config/config-store.spec.ts`、`ui/server/routes/config.test.js`、`ui/server/services/pilotdeckConfig.test.js`、`tests/cli/bootstrap-config.spec.ts`。merge、hash、redact、gateway/adapter parser、memory/tools parser 和 `PilotConfigStore` reload/watch 已纳入 `test:coverage`；`parseMemoryConfig.ts` 99.30% 行、`parseToolsConfig.ts` 99% 左右、`PilotConfigStore.ts` 96.82% 行。真实凭证为 `DEFER_EXTERNAL`，UI 配置服务和跨进程 watcher 仍需入口 smoke/mutation 证据。

## 验收与变更

验收覆盖默认配置、merge、无效配置、reload 失败保留、placeholder 清理、secret redaction、PILOT_HOME 隔离和 watcher stop。
