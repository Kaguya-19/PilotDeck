# Permission Decision TRD

状态：评审中　维护者：Permission 团队

## 代码边界

覆盖 `src/permission/**`、Gateway permission RPC、tool permission context 和 elicitation/ask user 交互。

## 核心契约

- safety deny 和 explicit deny 优先于 plan、bypass、session allow。
- permission request 有唯一 requestId、sessionKey 和 toolCallId。
- allow/deny/cancel/timeout 都必须释放 pending waiter。
- 回答迟到或对应 turn 已结束时返回 delivered=false，不修改新 turn。

## 测试

映射 `tests/tool/builtin/bashPermissions.test.ts`、`tests/gateway/**`、adapter permission tests。补充 deny precedence、late response、close abort 和 mutation proof。

## 验收

权限模式、规则匹配、交互回答和取消路径可离线确定性验证。
