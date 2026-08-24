# Home Assistant 平台附录

状态：评审中　维护者：Channel 团队

## 代码边界与连接

源码入口：`src/adapters/channel/homeassistant/HomeAssistantChannel.ts`、`HomeAssistantSessionMapper.ts`、`homeassistant-render.ts`。使用 Home Assistant webhook/REST 与 token；`start/stop` 管理事件订阅和请求。

## 契约

session key 由 instance、conversation 和 user 组成；自动化事件和对话消息映射为 Gateway turn。服务调用、附件和 permission 必须保留 request identity。

## 恢复与证据

实例断线按退避恢复，危险服务调用仍受 permission policy 约束。真实 Home Assistant 实例：`DEFER_EXTERNAL`；当前共享测试：`tests/adapters/im-permission-helper.spec.ts`。
