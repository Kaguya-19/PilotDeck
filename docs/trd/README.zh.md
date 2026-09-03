# PilotDeck TRD 索引

状态：评审中　维护者：PilotDeck 工程团队

本目录记录 PilotDeck 的后端接口、运行时和数据存储契约。设置页面对应的接口集中在“设置接口”小节；通用配置读写和凭证运行时规则分别由 `GET/PUT /api/config` 及配置运行时实现负责。

## 设置接口

| 编号 | 文档 | 主要边界 |
|---:|---|---|
| 52 | [Model Pool Settings API](52-model-pool-settings-api.zh.md)；[接口文档](../model-pool-settings-api.md) | provider/model 配置、批量连接测试和图片能力补录 |
| 53 | [Router Settings API](53-router-settings-api.zh.md) | 路由开关、任务层级、子智能体策略和模型定价 |
| 54 | [Agent Search Settings API](54-search-settings-api.zh.md) | 五类搜索 provider、配置和服务探测 |

## 数据存储与运行时

| 需求 | 文档 | 主要边界 |
|---:|---|---|
| 一 | [LLM 调用日志存储](55-llm-invocation-log.zh.md) | 主/子 session 的 provider-native request/response、attempt、流式原文和异步落库 |
| 二 | [Workspace Snapshot Storage](52-workspace-snapshot.zh.md) | Legal workspace manifest、MD5 内容对象和异常轮次快照 |

## 操作指南

- [Legal 数据存储启用指南](../legal-data-storage-guide.zh.md)：环境变量、启动、验证和故障排查。
