# SMS 平台附录

状态：评审中　维护者：Channel 团队

## 代码边界与连接

源码入口：`src/adapters/channel/sms/SmsChannel.ts`、`SmsSessionMapper.ts`、`sms-render.ts`。使用 provider webhook 与发送 API；`start/stop` 管理本地回调和 delivery queue。

## 契约

session key 由 E.164 对端号码和 conversation 组成；短文本映射为 Gateway turn，长文本按平台限制拆分且保持顺序。provider message id 去重。

## 恢复与证据

签名错误、429 和发送失败必须可见，重试不得重复收费投递。真实短信账号：`DEFER_EXTERNAL`；当前共享测试：`tests/adapters/im-permission-helper.spec.ts`。
