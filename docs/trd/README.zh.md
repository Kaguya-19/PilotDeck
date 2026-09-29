# PilotDeck 设置接口 TRD 索引

状态：评审中　维护者：PilotDeck 工程团队

本目录记录设置页面对应的后端接口契约。通用配置读写和凭证运行时规则分别由 `GET/PUT /api/config` 及配置运行时实现负责。

AgentLoop 模块化框架的文档入口见 [AgentLoop Modular Framework 文档总览](../agent-loop-modular-index.zh.md)。

| 编号 | 文档 | 主要边界 |
|---:|---|---|
| 03 | [AgentLoop Modular Framework](03-agent-loop-modular.zh.md) | AgentLoop ports、sidecar module protocol、宿主 context/tool 边界 |
| 04 | [PilotDeck DSH 风格模块化 Roadmap](04-dsh-modularization-roadmap.zh.md) | DSH seam 对照、当前成熟度、Session/Scope/Capability 分阶段迁移 |
| 05 | [DSH 与 PilotDeck 当前执行 Roadmap](05-dsh-pilotdeck-current-roadmap.zh.md) | 当前架构核对结论、未闭环 owner、sidecar stdio 与部署级交付顺序 |
| 52 | [Model Pool Settings API](52-model-pool-settings-api.zh.md)；[接口文档](../model-pool-settings-api.md) | provider/model 配置、批量连接测试和图片能力补录 |
| 53 | [Router Settings API](53-router-settings-api.zh.md) | 路由开关、任务层级、子智能体策略和模型定价 |
| 54 | [Agent Search Settings API](54-search-settings-api.zh.md) | 五类搜索 provider、配置和服务探测 |

第三节“智能体常驻”不在本次设置接口 TRD 范围内。
