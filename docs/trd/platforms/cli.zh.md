# CLI Channel 平台附录

状态：评审中　维护者：CLI 团队

## 代码边界与连接

源码入口：`src/adapters/channel/cli/CliChannel.ts`、`cli-render.ts`。使用本地 stdin/stdout 或命令调用，不依赖平台网络；`start/stop` 管理 readline、signal 和输出流。

## 契约

session key 由工作目录、显式 session 参数和进程实例组成；每条输入映射一个 Gateway turn，文本和附件结果输出到 stdout。交互 permission/elicitation 必须不与诊断 stderr 混流。

## 恢复与证据

EOF、SIGINT、Gateway busy 和 abort 都必须退出或返回明确状态，重复 stop 幂等。当前 CLI adapter 入口为 `CURRENT_ONLY`，通用测试：`tests/adapters/im-permission-helper.spec.ts`；真实终端行为：`DEFER_EXTERNAL`。
