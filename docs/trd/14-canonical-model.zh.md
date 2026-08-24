# Canonical Model Protocol TRD

状态：评审中　维护者：Model Protocol 团队

## 代码边界

覆盖 `src/model/protocol/**`、request/response 类型和 provider adapter 的共同 canonical contract。

## 核心契约

- canonical message/tool input 必须深拷贝隔离。
- tool call、tool result、usage、finish reason 和 error 使用稳定字段。
- provider 不支持的字段必须显式丢弃或返回结构化错误，不能猜测。
- canonical stream 恰有一个可识别终态。

## 测试

映射 `tests/model/**` 和 malformed fixtures。纯协议目录目标 100% coverage，并为关键修复加入 mutation proof。

## 验收

四协议输入输出可以规范化到同一模型事件语义，动态字段可在 contract fixture 中稳定比较。
