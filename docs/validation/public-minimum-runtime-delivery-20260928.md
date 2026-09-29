# 9月28日最小链路：PD 公共模型与文本解析增量

基线为已提交整合 PD `6ec2e2bc3`。本批只改 public owner 的 `src/composition/activeRuntimeModelPorts.ts`、`activeRuntimeTextParsing.ts`、`publicHostRuntimeAdapter.ts` 和聚焦测试；不覆盖共享 `createLocalGateway.ts` 或 Gateway/HTTP/modules.js。固定提交见本文件所在提交。

## 生产 root 窄接线

整合 owner 在当前 `createLocalGateway.ts` 的 `getPublicHostCapabilities` 内，于 `const runtime = registry.resolve()` 后构造：

```ts
const modelPorts = createActiveRuntimeModelPorts({
  config: runtime.snapshot.config.model,
  model: runtime.model,
  catalog: () => sessionModels.modelCatalogList({ includeAuto: false }),
});
const textParse = createActiveRuntimeTextParsingPort();
```

从 `../composition/activeRuntimeModelPorts.js`、`../composition/activeRuntimeTextParsing.js` 仅新增这两个 import；原 `profile`、`tools`、`skills`、`context` 均保持。原 `model.catalog` 保持，其同层添加 `prepare: modelPorts.prepare, stream: modelPorts.stream`；与其同层添加 `file: { parse: textParse }`。不要实例化第二 ModelRuntime/目录/任务机、不要改已有 native/external/disabled SkillManagement 选择。当前创建的是每次调用绑定 registry 当前 active generation 的同一 `runtime.model` 和 `runtime.snapshot.config.model`，与既有 catalog 取交集；不会悄悄选旧 generation 或其他 provider。

`model_prepare` 要求 `{requestId,modelId,request,budget?}`，modelId 是 catalog 完整 `provider/model` ID。输出 `{requestId,selection:{requestedModelId,selectedModelId,providerId},request}`。`model_stream` 同输入，返回 status200、`application/x-ndjson`、原 canonical async events、PD model/provider headers；signal 与 timeoutMs 传给原 `runtime.model.stream`。选中条目必须唯一且 available，request.model/provider 不得与其冲突。maxOutputTokens 按真实模型 cap 检查并作用于 request；maxInputTokens 缺实测 token 原语时明确400，不假装执行。输入错误由 mapper 保留400 code，原 provider 错误状态/结构保留。不会用近似 operation。

`file_parse` 当前仅支持 UTF-8 `.txt/.md/.markdown`，原字节 decode，默认/最大20MiB，错误格式415、超限413、无效编码422、abort499；不会用 SD parser 或默认转码冒充 PD 宿主。其结果是 `{filename,text,mediaType,metadata:{fileType,bytes}}`。PDF/docx 等若最小候选选用则仍须另补实际 PD parser，不能静默 fallback。

入库 APIJob/KnowledgeIngestJob、事件/cursor 与取消仍为 SD 领域状态 owner。该 file Port 本身不启动任务，更不能把 Bash task 当 ingest。SD Knowledge service 的生产 callback/DI 与 normal PD 对话 Knowledge 检索接线仍是独立未闭合项；模型与文件 helper 只有在上述 root hunk 实装后才可称生产挂载。有限版本尚无实际 enabled profile、fresh pair、真实模型调用或入库运行证据，均 NOT RUN。审批 mapping/human wait 依用户延期，但未装配时必须显错并禁止提交；原 G0–G7 和首失败 raw 不改。

聚焦检查：新增 5 项 tests 全过；所改文件/测试 TypeScript strict noEmit 无错误；`git diff --check` 通过。节点依赖通过隔离树临时 symlink 使用工作区已安装 node_modules，未改全局环境。无 push/merge/deploy。
