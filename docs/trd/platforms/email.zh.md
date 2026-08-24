# Email 平台附录

状态：评审中　维护者：Channel 团队

## 代码边界与连接

源码入口：`src/adapters/channel/email/EmailChannel.ts`、`EmailSessionMapper.ts`、`email-render.ts`。使用 IMAP/SMTP 或本地 mail transport；`start/stop` 管理 poll、连接和发送队列。

## 契约

session key 由 mailbox、thread 和 normalized Message-ID 组成；纯文本、HTML、内嵌图片和附件映射为 Gateway turn。Message-ID 去重，引用头保持 thread。

## 恢复与证据

IMAP 断线和 SMTP 失败按独立队列重试，凭证错误明确失败。真实邮箱和外部服务器：`DEFER_EXTERNAL`；当前共享测试：`tests/adapters/im-permission-helper.spec.ts`。
