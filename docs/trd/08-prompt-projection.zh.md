# Prompt Projection TRD

状态：评审中　维护者：Context 团队

## 代码边界

覆盖 `src/context/projection/**`、`src/context/prompt/**`、`src/context/input/**` 和模型请求构造中的输入 projection。

## 核心契约

- 用户原始消息、历史和 tool schema 不得被 projection 原地修改。
- system prompt、synthetic prompt、skill prompt、attachment 和 tool result 的顺序必须稳定。
- provider-specific projection 只能在 provider 边界发生。
- 不可见诊断内容不得进入用户可见 transcript。

## 测试

映射 context prompt、skill path、attachment guidance 和 model request tests。补充深拷贝、空内容、超长内容和 provider 差异 fixture。

## 验收

canonical input 可重复生成，动态 ID/path/token 可规范化，projection 失败返回结构化错误。
