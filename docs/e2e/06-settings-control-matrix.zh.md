# 设置控件逐项控制矩阵

本矩阵要求每个设置控件至少有一个真实浏览器用例。`控件` 包括按钮、toggle、select、文本框、数字框、复合编辑器和确认弹窗中的按钮。所有保存结果都要通过重新读取配置或重启后验证。

| 用例 ID | 页面/控件 | 类型与操作 | 初始值 | 预期配置/运行时结果 | 刷新验收 |
|---|---|---|---|---|---|
| `MAT-GEN-001` | 通用：主题、排序 | toggle/select 各切换两次 | 默认值 | UI 主题/项目顺序改变 | 保持 |
| `MAT-GEN-002` | 编辑器：theme、wrap、minimap、line numbers、font size | select/toggle/number 输入合法和非法值 | 默认值 | 编辑器即时变化，非法值拒绝 | 保持 |
| `MAT-GEN-003` | 通知、Web Push、事件类型、遥测 | toggle/checkbox | 默认值 | 通知和 telemetry 配置更新 | 保持 |
| `MAT-GEN-004` | Git name/email | 文本输入，保存 | 空或已有值 | Git 配置写入 | 保持 |
| `MAT-MODEL-001` | 模型池目录 provider | provider picker 按钮 | 无/已有 | 新 provider 草稿打开 | 保持 |
| `MAT-MODEL-002` | 自定义 provider | 添加、ID、协议、URL、API Key | 空 | provider 保存并可测试 | 保持 |
| `MAT-MODEL-003` | provider 模型列表 | 获取模型、添加模型、移除模型 | 空/目录模型 | model map 更新 | 保持 |
| `MAT-MODEL-004` | provider 卡片 | 展开/收起、高级展开/收起 | 展开 | 重试次数、stream timeout、base/max delay 更新 | 保持 |
| `MAT-MODEL-005` | provider 生命周期 | 重命名、保存、取消、移除 | 已有 provider | 引用同步；被引用时移除被拒绝 | 保持/拒绝 |
| `MAT-AGENT-001` | Agent Model 主模型/子模型 | select | 已配置模型 | `agent.model` 和 subagent default 更新 | 保持 |
| `MAT-AGENT-002` | Agent Model 图片能力 | checkbox | 目录默认值 | image capability override 更新 | 保持 |
| `MAT-AGENT-003` | Agent Model token | max output/max context number | 默认 placeholder | 正数写入；空/负数移除或拒绝 | 保持 |
| `MAT-AGENT-004` | Agent Model advanced | 展开/收起按钮 | 展开 | 高级字段可见性变化 | 保持 |
| `MAT-ROUTE-001` | Router 开关和级别模型 | toggle/select | 默认值 | Router 和各级模型生效 | 保持 |
| `MAT-ROUTE-002` | zero-usage/transient retry | toggle/number | 默认值 | retry 参数生效 | 保持 |
| `MAT-ROUTE-003` | Token Saver | toggle、default tier、judge timeout、policy | 默认值 | token saver 配置生效 | 保持 |
| `MAT-ROUTE-004` | tier/rule 编辑器 | 添加、编辑、删除、取消 | 空/已有 | tier/rule map 更新；取消无写入 | 保持 |
| `MAT-ROUTE-005` | 自动编排、场景、fallback | toggle、select、输入、增删 | 默认值 | 路由决策配置更新 | 保持 |
| `MAT-ROUTE-006` | 统计与价格 | toggle、input/output/cacheRead/unit 数字/文本 | 默认值 | 价格配置更新；非法值报错 | 保持 |
| `MAT-MEM-001` | 记忆 enabled/model | toggle/select | 默认值 | memory 子系统状态和模型更新 | 保持 |
| `MAT-MEM-002` | 索引/Dream 间隔 | number 编辑、提交、取消 | 默认值 | 间隔写入；取消恢复 | 保持 |
| `MAT-MEM-003` | 项目选择和数据管理 | select、导出、导入、清空/确认/取消 | 已有项目 | 导出文件、导入数据、清空结果正确 | 重开验证 |
| `MAT-RES-001` | Always-On enabled/trigger | toggle、interval、cooldown、budget、heartbeat、recent message、channel | 默认值 | trigger 配置和调度状态更新 | 保持 |
| `MAT-RES-002` | dormancy | toggle、debounce、ignore globs | 默认值 | dormancy 配置更新 | 保持 |
| `MAT-RES-003` | workspace | 路径、快照、字节数、计划数、Git LFS | 默认值 | workspace/snapshot 配置更新 | 保持 |
| `MAT-RES-004` | execution/project opt-in | turns、tool calls、timeout、项目选择 | 默认值 | 执行限制和项目接入更新 | 保持 |
| `MAT-SEARCH-001` | Web Search enabled/provider | toggle/select 五种 provider | 默认值 | provider endpoint 和字段切换 | 保持 |
| `MAT-SEARCH-002` | Search key/endpoint | secret/text 输入 | 空/遮罩 | secret 使用遮罩恢复；endpoint 更新 | 保持 |
| `MAT-SEARCH-003` | Custom Search | name、auth、method、参数、结果映射 | 空 | custom provider 请求配置更新 | 保持 |
| `MAT-SEARCH-004` | Search test | 测试连接按钮 | 已配置/缺 key | 真实成功、失败、缺 key 错误 | 状态可重开 |
| `MAT-CRON-001` | Cron enabled/timezone/concurrency | toggle/text/number | 默认值 | cron runtime 配置更新 | 重载验证 |
| `MAT-INT-001` | Gateway | enabled/home | 默认值 | Gateway 状态和目录更新 | 保持 |
| `MAT-INT-002` | IM channels | 登录、保存、刷新、重试、断开 | 未配置/已配置 | channel 状态和配置更新 | 保持 |
| `MAT-MCP-001` | MCP scope/load | select、刷新 | user/project | 列表按 scope 更新 | 保持 |
| `MAT-MCP-002` | MCP server lifecycle | stdio/remote 模板、添加、编辑、删除、确认/取消、保存 | 空/已有 | MCP 文件配置更新；取消无写入 | 保持 |
| `MAT-MCP-003` | MCP nested fields | 添加/删除 arg/env/variable/header，JSON 编辑 | 空/已有 | 嵌套字段序列化正确 | 保持 |
| `MAT-OFFICE-001` | Office service | builtin/libreoffice select | builtin | 预览服务切换 | 保持 |
| `MAT-OFFICE-002` | Office binary | 路径输入、扫描、候选选择、清空 | 空/已有 | binary path 更新；真实预览可用 | 保持 |
| `MAT-PRIV-001` | 权限模式 | mode select、skip toggle | 默认值 | 权限策略更新 | 保持 |
| `MAT-PRIV-002` | permission rules | allowed/blocked tools/commands 添加、删除 | 空/已有 | rule 文件更新 | 保持 |
| `MAT-ADV-001` | 服务与 custom env | host、ports、timeout、db、workspace、proxy、env 输入 | 默认值 | runtime 配置更新；端口可启动 | 重启验证 |
| `MAT-ADV-002` | raw YAML | 展开/收起、打开文件、刷新、reload、save/reload、忽略提示 | 合法 YAML | 文件和运行时配置同步；非法 YAML 阻止保存 | 重启验证 |
| `MAT-ABOUT-001` | 更新动作 | 检查、更新、下载安装、重启、安装、失败重试、刷新 | 当前版本 | 版本状态和进程状态符合结果 | 重开验证 |

## 矩阵执行约束

数字输入必须覆盖合法正数、零、负数、非数字和清空。secret 输入必须覆盖空值、真实值、遮罩值。所有删除/清空/重置/更新/重启按钮必须覆盖确认和取消两个分支。
