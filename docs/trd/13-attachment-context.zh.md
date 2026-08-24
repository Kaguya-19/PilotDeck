# Attachment Context TRD

状态：评审中　维护者：Context/Session 团队

## 代码边界

覆盖 `src/context/attachments/**`、multimodal projection、workspace attachment 和 Gateway attachment guidance。

## 核心契约

- 附件必须经过项目路径、大小、MIME 和生命周期校验。
- 图片、PDF、Office、普通文件和结构化引用使用明确的 canonical block。
- 附件不应被普通文本误识别为授权路径列表。
- 过期、跨项目、缺失或解密失败的附件不得启动模型调用。

## 测试

映射 `tests/gateway/attachment-guidance.spec.ts`、model media tests、Weixin attachment tests 和 UI attachment tests。

## 验收

覆盖成功解析、unsupported media、path escape、过期、重复和失败回滚；真实文件仅使用临时目录。
