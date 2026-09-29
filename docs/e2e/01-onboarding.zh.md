# Onboarding 真实 E2E 用例

## 范围与数据

使用全新的隔离 `PILOT_HOME`、SQLite 用户库和临时 workspace。首次访问时用户未完成 onboarding，页面依次经过语言、Provider、连接和工作区步骤。OpenAI、Anthropic/Claude、Google AI/Gemini 各执行完整流程；同一套步骤也覆盖自定义 Provider。

## 用例

| 用例 ID | 前置条件 | 操作与按钮 | 预期结果 | 清理/级别 |
|---|---|---|---|---|
| `ONB-LANG-001` | 首次进入语言页 | 点击中文、英文，再点击继续 | 语言即时切换；进入 Provider 页；刷新后语言保持 | 重置 locale / 普通 |
| `ONB-PROVIDER-001` | Provider 页 | 依次点击自定义、OpenAI、Anthropic、Google AI 卡片 | 卡片 `aria-pressed` 与选中状态同步；下一步仅在选中后可用 | 普通 |
| `ONB-PROVIDER-002` | Provider 列表请求可用 | 点击服务端返回的每个 provider 卡片 | 每个卡片均可选中；logo/名称可见；未发生页面错误 | 普通 |
| `ONB-NAV-001` | Provider 未选择 | 点击下一步、返回 | 未选择时下一步禁用；返回不丢失已选语言 | 普通 |
| `ONB-CONN-001` | 选中 OpenAI/Claude/Gemini | 点击下一步，核对 provider 名称和协议展示 | 进入连接页；协议、默认 endpoint 和 API Key 要求与 provider 一致 | 普通 |
| `ONB-CONN-002` | 自定义 Provider | 填 provider ID；在协议选择中逐项选择 OpenAI、OpenAI Responses、Anthropic、Google；填写 endpoint | 字段值受控保存；非法 ID 显示校验错误；合法值可继续 | 普通 |
| `ONB-CONN-003` | 连接页 | 输入 API Key，点击显示/隐藏密钥 | input 在 password/text 间切换；值不变；日志和 DOM 外部文本不泄漏密钥 | 普通 |
| `ONB-MODEL-001` | Provider 有模型目录 | 在模型搜索框输入匹配和不匹配文本 | 可用模型列表正确过滤；空结果有明确状态 | 普通 |
| `ONB-MODEL-002` | 连接页 | 点击添加模型 ID，输入合法 ID，按 Enter；重复按 Enter/失焦 | 模型加入已选列表；重复值不重复；达到上限时按产品规则留在可用列表 | 普通 |
| `ONB-MODEL-003` | 有可用模型 | 点击模型 chip 选择，再点击已选模型移除 | 选中/移除状态更新；移除的自定义模型重新出现在可用列表 | 普通 |
| `ONB-MODEL-004` | 有可用模型 | 点击可用模型右侧移除/隐藏按钮 | 模型从可用列表隐藏；搜索也不能重新显示，直到重新加入 | 普通 |
| `ONB-CONN-004` | API Key 或模型缺失 | 点击连接测试 | 测试按钮显示 testing 并禁用；缺失必填字段显示可操作错误；不发送不完整请求 | 普通 |
| `ONB-CONN-005` | 使用真实 LLM Center 和有效模型 | 点击连接测试 | 三种协议分别返回成功；按钮显示通过；响应中包含 provider/model；无 mock 请求 | 普通 |
| `ONB-CONN-006` | 使用错误 key、错误 endpoint 或错误 model | 点击连接测试，再点击重试 | 显示失败原因；重试重新发起真实请求；成功后状态恢复通过 | 普通 |
| `ONB-IMAGE-001` | 真实测试返回 image capability unknown | 在补录弹窗分别点击支持/不支持、关闭、取消、确认 | 关闭/取消不保存；确认后每个模型结果写入连接测试配置 | 普通 |
| `ONB-NAV-002` | 连接测试通过 | 点击返回、下一步 | 返回 Provider 后重新进入连接页仍保留值；下一步进入工作区 | 普通 |
| `ONB-WORKSPACE-001` | 工作区页 | 输入已有临时目录，点击选择/继续 | 路径校验通过；目录存在且成为工作区 | 普通 |
| `ONB-WORKSPACE-002` | 工作区页 | 点击新建工作区，填写名称/路径，点击创建；再点击关闭 | 创建成功后 modal 关闭且列表/路径更新；关闭不产生目录 | 创建/普通 |
| `ONB-WORKSPACE-003` | 工作区页 | 填 GitHub URL，选择 token 模式，选择已有 token 或新建 token | 字段切换正确；非法 URL/token 显示错误；合法值进入 review | 普通 |
| `ONB-GIT-001` | 工作区 Git 配置可见 | 填 Git 名称和邮箱，点击保存 | 配置保存；重新打开仍显示；不影响 provider secret | 普通 |
| `ONB-WORKSPACE-004` | workspace 创建失败场景 | 点击完成 | 显示失败原因，仍停留在工作区，可重试；不标记 onboarding 完成 | 普通 |
| `ONB-FINISH-001` | 临时 workspace 和有效模型 | 点击完成 | 真正创建 workspace；`complete-onboarding` 成功；跳转主应用；配置和用户状态持久化 | 删除 workspace/创建/普通 |
| `ONB-FINISH-002` | 工作区页 | 点击跳过聊天配置 | 真实调用完成接口并进入主应用；不伪造模型配置 | 恢复隔离库/普通 |
| `ONB-PERSIST-001` | 已完成 onboarding | 刷新并重新打开 | 不回到 onboarding；provider、model、workspace 在会话和设置中可见 | 删除隔离 HOME/普通 |

## 模型执行要求

`ONB-CONN-005` 和 `ONB-FINISH-001` 对 OpenAI、Claude、Gemini 各执行一次。Claude 使用 Anthropic 协议，Gemini 使用 Google 协议，不能把三者都按 OpenAI endpoint 验证。
