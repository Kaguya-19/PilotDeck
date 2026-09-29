# 设置真实 E2E 用例

## 通用规则

进入设置后先点击侧边栏返回、所有一级菜单和所有二级菜单。每个控件操作后断言 UI、配置保存响应、重新加载结果和运行时效果。详情见 [06-settings-control-matrix.zh.md](./06-settings-control-matrix.zh.md)。

## 导航和通用动作

| 用例 ID | 操作 | 预期结果 | 级别 |
|---|---|---|---|
| `SET-NAV-001` | 点击通用、模型池、智能体各子页、外部集成、扩展各子页、安全隐私、高级、关于 | 每个页面标题、内容和选中态正确；无 console 错误 | 普通 |
| `SET-NAV-002` | 点击返回应用、移动端返回设置、桌面/移动端切换 | 正确回到应用或设置导航；表单草稿按产品规则处理 | 普通 |
| `SET-SAVE-001` | 修改任意设置后刷新或重新打开设置 | 保存值仍存在；未保存值不被误写入 | 普通 |
| `SET-SAVE-002` | 制造配置冲突、非法 YAML、后端错误 | 错误信息准确；保存按钮状态恢复；旧配置不被破坏 | 普通 |

## 子页覆盖

### 通用

测试深色模式、项目排序、编辑器主题、自动换行、缩略图、行号、字体大小、通知/Web Push、事件类型、遥测、Git 名称、Git 邮箱和保存按钮。每个 toggle/select/input 都执行正向切换、反向切换和刷新持久化。

### 模型池

测试目录 provider 添加、自定义 provider 添加、provider ID/协议/URL/API Key 编辑、获取模型、添加/删除模型、展开/收起、高级重试参数、provider 重命名、保存、取消、移除。删除仍被 Agent/Router/Memory 引用的 provider/model 时，验证确认后服务端返回阻止，配置不得变化。

### 智能体

模型页测试主模型、子智能体模型、图片输入、最大输出 token、最大上下文 token、高级展开/收起。路由页测试 Router、Default/Judge/Simple/Medium/Complex/Reasoning、zero-usage retry、transient retry、Token Saver、tier/rule 增删编辑、自动编排、场景、fallback、统计和价格。

记忆页测试启用、记忆模型、索引/Dream 间隔、项目选择、index/dream 编辑提交/取消、导出、导入、清空确认/取消。常驻页测试 Always-On 全部 trigger、dormancy、workspace、execution 和 project opt-in 控件。搜索页测试 Web Search、GLM/Tavily/Serper/Brave/Custom、API Key、endpoint、自定义鉴权/方法/参数/映射和测试连接。定时任务页测试 Cron、时区和最大并发。

### 外部集成与扩展

外部集成测试 Gateway enabled/home、飞书、微信、企业微信的登录、保存、刷新状态、失败重试和断开。MCP 测试 scope、刷新、stdio/remote 模板、参数/环境变量/变量/请求头增删、高级 JSON、编辑、删除确认/取消和保存。Office Preview 测试 builtin/libreoffice、binary path、扫描、候选路径选择、清空和保存后的真实 Office 预览。

### 安全隐私、高级、关于

安全隐私测试权限模式、跳过确认、允许/禁用工具、允许/阻止命令、规则添加/删除。高级测试服务字段、custom environment、raw YAML 展开/收起、打开配置文件、刷新、重新加载、保存并重载、外部提示忽略以及非法 YAML 阻止保存。关于测试检查更新、Web 更新、下载并安装、重启、安装、失败重试和页面刷新。

## 破坏性操作

清空记忆、删除 MCP、删除规则、重置默认值、更新、重启等按钮只在隔离环境真实执行。每个用例必须记录确认按钮、最终文件/配置/进程状态以及清理或恢复动作。
