# Tool Description and Schema TRD

状态：评审中　维护者：Tool/Agent 团队

## 代码边界

覆盖 builtin tool description、`inputSchema`、`toolToCanonicalSchema` 和 provider schema materialization。

## 核心契约

- description 和 schema 必须与实际执行能力一致。
- schema key、enum、required 和 description 不能被 provider 转换静默破坏。
- tool description 总量应受 context budget 约束，超限有诊断。
- schema 输出排序、去重和动态字段规范化必须稳定。

## 测试

映射 `tests/tool/**`、model request tests、tool schema tests。补充 schema malformed、描述漂移、token budget 和 keyless contract。

## 验收

同一 registry 生成稳定 canonical schema；schema 失败在模型请求前明确返回。
