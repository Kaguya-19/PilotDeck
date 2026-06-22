# PilotDeck 自动压缩改进建议

本文基于 `feat/better-comp-0618` 当前实现与 [PilotDeck 自动压缩机制](./context-compaction.md)，对照 Hermes、Claude Code / Claude API compaction、opencode 与 OpenClaw，总结下一阶段可落地的改进方向。目标不是重写压缩系统，而是在现有“provider token count + micro/snip/full + protected tool result”的基础上，补齐可观测、可配置、可评估和可演进能力。

## 1. 当前状态

`feat/better-comp-0618` 已经把自动压缩从单一 summary fallback 推进成分层预算控制：

- token accounting 统一走 `TokenAccountingRuntime`，优先使用 OpenAI / Anthropic 官方 token count API，失败后回退本地 `o200k_base` 估算和 padding。
- 每次模型调用前预留输出空间，默认 `config.maxOutputTokens ?? 4096`，预算判断使用 `maxContextTokens - reservedOutputTokens`。
- `80% <= ratio < 95%` 时只做 cheap micro compaction，不调用 full summary。
- `ratio >= 95%` 时先 micro，再按需升级到 snip / full summary。
- routing 后如果目标 provider/model 的 context window 更小，会基于 routed request 再做 post-routing compact。
- micro / snip / full 都有保护型 tool result 白名单，默认保护 `read_skill`、`ask_user_question`、`todo_write`、`structured_output`、`agent` / `task_*` 等关键语义结果，并识别显式 `<memory-context>` 文本消息。
- 压缩只改将要发送给模型的 prompt 视图，不改 durable transcript，并持续维护 `tool_call` / `tool_result` 配对完整性。

这些改动已经解决了三个核心问题：减少 full summary 频率，降低 token 估算低估风险，以及避免压缩掉 skill、用户澄清、todo、子任务结果等高价值上下文。

当前主要不足也比较清楚：

- 策略大多还是内部常量。warning/blocking 阈值、保留最近几条、tool result preview 长度、保护名单等都没有形成清晰的 policy surface。
- 缺少 context breakdown 可观测能力。现在可以知道是否超预算，但不容易知道 token 被 system prompt、tool schema、历史消息、tool results、protected turns、summary、cache breakpoints 分别吃掉多少。
- full summary 质量不可度量。压缩后是否保留目标、决策、文件路径、错误、剩余任务，只能靠人工读 summary 或后续模型表现判断。
- memory flush 不够主动。当前只保护已经进入 messages 的 `<memory-context>`，但 full compact 前没有明确“写入长期记忆 / checkpoint”的动作。
- 不同 agent、model、provider 还没有独立策略。routing 后只调整 context window，尚不能按模型窗口、成本、cache 能力、agent role 调整阈值、reserved budget 或是否允许 snip/full。

## 2. 外部系统对照

### Hermes

Hermes 文档明确采用双层压缩：gateway session hygiene 在 85% 左右作为进入 agent 前的安全网，agent 内部 `ContextCompressor` 默认在 50% 触发，使用更准确的 API reported tokens。它还把 `threshold`、`target_ratio`、`protect_last_n` 暴露到配置，并支持 auxiliary compression model/provider。参见 [Hermes Agent Context Compression and Caching](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching)。

Hermes 的算法形态也值得借鉴：先 cheap prune 旧工具结果，再划分 head / summarized middle / tail，边界对齐 tool call / result group，最后生成结构化 summary，并支持后续迭代更新 previous summary。它的 prompt caching 文档也强调压缩会影响 prefix cache，系统 prompt cache 要尽量稳定。

本地日志也印证了 Hermes agent compressor 的实际参数：`/Users/a1/Desktop/claw/openbmb/hermesagent/.../agent.log` 中可见 `threshold=64000 (50%)`、`target_ratio=20%`、`tail_budget=12800`。这说明 Hermes 偏向更早、更主动地整理上下文，而不是等到接近窗口末端才处理。

### Claude Code / Claude API

Claude Code 在 settings 中暴露 `autoCompactEnabled`，默认开启，用于在上下文接近限制时自动压缩；这说明“是否自动压缩”本身应该是用户可理解的开关。参见 [Claude Code Settings](https://code.claude.com/docs/en/settings)。

Claude API compaction 则提供 server-side compaction：请求中配置 `context_management.edits` 后，Claude 会在输入超过指定 trigger 时生成 `compaction` block，并在后续请求中忽略该 block 之前的旧内容。API 还支持 trigger token、`pause_after_compaction`、自定义 summary instructions、compaction block caching 与 usage iterations。参见 [Claude API Compaction](https://platform.claude.com/docs/en/build-with-claude/compaction)。

对 PilotDeck 来说，Claude API 的重点启发不是直接迁移 server-side compaction，而是三点：压缩可以成为协议中的一等结构，summary instructions 应该可定制，压缩事件应有 usage / diagnostics 记录。

### opencode

opencode 的公开配置面很小，但直指关键开关：`compaction.auto`、`compaction.prune`、`compaction.reserved`。参见 [opencode Config: Compaction](https://opencode.ai/docs/config/#compaction)。

这对 PilotDeck 的启发是：第一阶段不必暴露复杂引擎，但应该给用户和上层 agent 一个稳定、可解释的 policy surface。尤其是 `reserved` 这种输出/压缩缓冲预算，属于用户很容易理解、也很容易调优的参数。

### OpenClaw

OpenClaw 把 context 可观测做成用户可直接查看的能力：`/status` 看窗口占用和 compaction count，`/context list` 看注入项和粗略大小，`/context detail` 看 system prompt、tool schema、skill entry、compactable transcript 等细分，`/context map` 用 treemap 展示上下文来源。参见 [OpenClaw Context](https://docs.openclaw.ai/concepts/context)。

OpenClaw compaction 也有几个很实用的点：auto-compaction 默认开启；模型返回 context overflow error 时可 reactive compact 并 retry；压缩前提醒 agent 保存重要 notes 到 memory；手动 `/compact` 可带 instructions，例如“Focus on the API design decisions”；压缩仍保持 tool call / result 配对，并且完整历史仍在磁盘。参见 [OpenClaw Compaction](https://docs.openclaw.ai/concepts/compaction)。

这些做法说明，压缩不仅是 token 技术问题，也是一套用户信任机制：用户要知道为什么压、压了什么、保留了什么、压缩前有没有机会把关键信息落到长期记忆。

## 3. 主要差距

对照这些系统，PilotDeck 当前最缺的不是“再多一种压缩算法”，而是四类工程能力。

第一是可观测。现在的 `context_budget` snapshot 可以说明整体 token ratio，但无法回答“最大 token 消耗来自哪里”。当 protected tool result 过多导致 micro 无效、snip 仍超预算时，调试成本会很高。

第二是 policy surface。PilotDeck 已有很好的默认策略，但用户、agent 配置、routing 决策无法表达“这个 agent 更保守”“这个 provider 需要更多 output reserve”“这个任务不允许 full summary”“这个工具结果必须保护”等意图。

第三是 summary 质量控制。full summary 是最有损的一步，目前缺少结构化 summary contract、校验诊断、摘要覆盖率检查，也没有“压缩后模型是否还能继续任务”的自动信号。

第四是 memory 与 cache 协同。压缩前没有主动 memory checkpoint；Anthropic / prompt-cache 场景下，micro preview、snip、full 都可能改变稳定 prefix，省 token 与 cache hit 之间需要更明确的取舍。

## 4. 推荐路线图

### P0：先补可观测与文档化事件

P0 不改变行为，只让系统解释自己。建议给每次预算评估和压缩事件补充结构化 diagnostics：

- `contextBreakdown`：system prompt、tool schema、messages、tool results、images/files、summary、protected messages、cache breakpoints。
- `compactCount`：当前 session / turn 的累计压缩次数。
- `preTokens` / `postTokens` / `deltaTokens` / `ratioBefore` / `ratioAfter`。
- `tokenSource` / `exact` / `estimatorError`，直接透出 provider count 还是 local fallback。
- `protectedCount` / `protectedToolNames` / `protectedTokenEstimate`。
- `snippedTurnCount` / `summarizedTurnCount` / `tailTurnCount`。
- `toolResultPreviewBytesSaved` / `largeToolResultPreviewCount` / `repeatedErrorFoldCount`。

这一步收益很大：后续所有策略改动都能用真实 session 数据评估，而不是靠主观感觉调阈值。

### P1：暴露压缩 policy，但保持默认不变

建议新增内部稳定 policy 对象，再逐步映射到配置。第一版可以只在 runtime options 中启用，避免一次性扩 schema：

```ts
type CompactionPolicy = {
  auto?: boolean;
  warningRatio?: number;
  blockingRatio?: number;
  reservedOutputTokens?: number;
  micro?: {
    pruneLargeToolResults?: boolean;
    largeToolResultChars?: number;
    preserveRecentResultsPerTool?: number;
  };
  protectedToolNames?: string[];
  snip?: {
    keepHeadTurns?: number;
    keepTailTurns?: number;
  };
  full?: {
    enabled?: boolean;
    instructions?: string;
  };
};
```

默认值继续沿用当前实现：80% warning、95% blocking、默认 output reserve、非保护旧大工具结果 preview、保护名单内结果原样保留。重点是把“行为常量”变成“策略对象”，为 per-agent / per-model 做准备。

### P1：full compact 前做 memory flush / checkpoint

full summary 是最可能丢语义的步骤。建议在进入 full compact 前增加 best-effort checkpoint：

1. 从即将 summarized 的 prefix 中抽取候选 facts：用户偏好、明确决策、文件路径、API 约定、未完成任务、错误与 workaround。
2. 调用 memory provider 或 agent 内部 checkpoint hook，写入长期记忆或 session-local compact note。
3. checkpoint 失败只记录 diagnostics，不阻断压缩。
4. full summary prompt 中声明哪些 facts 已 checkpoint，避免重复冗长总结。

这对应 OpenClaw “压缩前提醒 agent 保存重要 notes 到 memory”的设计，但 PilotDeck 可以做得更结构化：不一定让主模型再思考一轮，也可以由 context runtime 做轻量抽取和 provider hook。

### P1：让 full summary 有结构化 contract 和诊断

建议把 full summary 从自由文本升级成稳定 sections：

- `Objective`
- `Completed`
- `Remaining`
- `Files`
- `Decisions`
- `Tool Findings`
- `Errors`
- `Open Questions`

生成后做轻量 validation diagnostics：

- 是否包含当前用户目标。
- 是否覆盖 summarized prefix 中的 protected tool names / protected turns。
- 是否保留文件路径、命令、错误码、API 名称等高熵实体。
- summary token 数是否落在目标区间。
- 是否产生空 section 或明显模板化废话。

v1 可以只记录 diagnostics，不必自动 reject summary；等数据足够后，再考虑失败重试或换 summary model。

## 5. 具体设计草案

### 5.1 Context Breakdown

新增一个只读分析器，输入 materialized request，输出 breakdown：

```ts
type ContextBreakdown = {
  totalInputTokens: number;
  maxContextTokens: number;
  reservedOutputTokens: number;
  source: "provider" | "local" | "mixed";
  exact: boolean;
  categories: Array<{
    name: "system" | "tool_schema" | "messages" | "tool_results" | "attachments" | "summary" | "protected" | "cache";
    tokens: number;
    items?: number;
    notes?: string[];
  }>;
};
```

如果 provider count 只能给 total，category 可以用本地 estimator 分摊，`source: "mixed"` 即可。关键是让 UI、logs、tests 能看到“谁在占窗口”。

### 5.2 Manual Compact

新增一个内部 manual compact 入口，允许带 instructions：

```ts
contextRuntime.compact(messages, {
  mode: "manual",
  instructions: "保留 API design decisions、文件路径和未完成 TODO",
  keepRecentTokens: 12000,
});
```

它可以先复用 full compaction engine，不必新增协议事件。后续再把这个入口暴露成 CLI / UI command。

### 5.3 Per-model / Per-agent Policy

routing 后目前只使用 routed context window。下一步可以让 router 返回或 materialize policy override：

```ts
type RoutedCompactionPolicy = {
  reservedOutputTokens?: number;
  warningRatio?: number;
  blockingRatio?: number;
  allowSnip?: boolean;
  allowFull?: boolean;
  protectedToolNames?: string[];
};
```

典型策略：

- 小窗口模型：更早 micro，更大 reserved output，更积极 snip。
- 长上下文高成本模型：更早 full summary，减少长期输入成本。
- 强 cache provider：尽量推迟会破坏 stable prefix 的 snip/full。
- planner agent：保护 todo、决策、用户澄清。
- researcher agent：保护 search synthesis、agent result，但不保护原始 web/read_file 大结果。

### 5.4 Cache-aware Pruning

当前 `CachedMicroCompactionEngine` 与 micro preview 策略可以继续分工，但需要更明确的 cache-aware 决策：

- Anthropic cache path 上优先保留稳定 system prompt 与 cache breakpoint 之前的 prefix。
- warning 区间优先压缩 tail 附近的旧大工具结果，避免每轮改写很早的 prefix。
- 如果 full compact 必然破坏 prefix cache，记录 `cacheInvalidationExpected: true`。
- 对 protected turn 保留原文时，尽量保持 turn 相对顺序稳定，减少 cache churn。

### 5.5 Pluggable Context Engine

长期可以参考 Hermes / OpenClaw，把 context engine 变成可替换能力：

```ts
interface ContextEngine {
  evaluate(request: CanonicalModelRequest): Promise<TokenBudgetSnapshot>;
  compact(request: CanonicalModelRequest, policy: CompactionPolicy): Promise<CompactResult>;
  explain(request: CanonicalModelRequest): Promise<ContextBreakdown>;
}
```

默认 engine 继续使用当前 micro/snip/full。未来可接入 lossless context store、RAG-style retrieval、project index、或模型专属 server-side compaction。

## 6. 风险与取舍

- 可配置会增加错误空间。阈值过低会频繁压缩，阈值过高又可能溢出；因此默认策略要保守，配置要有 bounds 和 diagnostics。
- 保护名单不是越长越好。保护太多会让 micro/snip 失效，最终只能 full 或直接超预算；需要通过 `protectedTokenEstimate` 暴露成本。
- memory flush 可能引入延迟和额外模型调用。建议 best-effort、短超时、失败不阻断，并允许在低风险 provider 上关闭。
- summary validation 不能过度自信。早期只做诊断，不应因为一个启发式检查失败就丢弃可用 summary。
- cache-aware pruning 与 token 节省存在冲突。长会话里 cache hit 能显著降成本，但在真正接近窗口时，优先级仍应回到“请求能发出去”。
- pluggable engine 会扩大维护面。应先把当前 engine 的接口边界梳理清楚，再允许替换。

## 7. 建议优先级

| 优先级 | 建议 | 主要收益 | 风险 |
| --- | --- | --- | --- |
| P0 | context breakdown、compact diagnostics、token delta | 可调试、可评估、方便后续策略迭代 | 低，只增加观测 |
| P1 | policy object / config surface | 让阈值、reserve、保护名单可控 | 中，需要 bounds 与兼容默认 |
| P1 | full compact 前 memory checkpoint | 降低关键事实丢失概率 | 中，可能增加延迟 |
| P1 | 结构化 summary contract + diagnostics | 提升 full summary 可用性 | 中，prompt 与测试需稳定 |
| P2 | per-model / per-agent policy | 适配 routing、多 agent、不同窗口模型 | 中高，策略冲突需要治理 |
| P2 | cache-aware pruning | 降低 Anthropic / prompt-cache 路径成本 | 中，收益依赖 provider |
| P2 | manual compact with instructions | 给用户和 agent 主动控制权 | 中，需要交互入口 |
| P3 | pluggable context engine | 支持 lossless / context-store / RAG 演进 | 高，架构影响大 |

建议实施顺序：

1. 先做 P0 diagnostics，不改变压缩结果。
2. 再把当前常量收束成 policy object，但保持默认行为完全一致。
3. 接着补 full compact 的 memory checkpoint 和 structured summary。
4. 有真实 telemetry 后，再推进 per-model/per-agent 与 cache-aware 策略。
5. 最后再考虑 pluggable engine，避免过早抽象。

## 8. 参考资料

- [PilotDeck 自动压缩机制](./context-compaction.md)
- [Hermes Agent Context Compression and Caching](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching)
- [Claude API Compaction](https://platform.claude.com/docs/en/build-with-claude/compaction)
- [Claude Code Settings: autoCompactEnabled](https://code.claude.com/docs/en/settings)
- [opencode Config: Compaction](https://opencode.ai/docs/config/#compaction)
- [OpenClaw Context](https://docs.openclaw.ai/concepts/context)
- [OpenClaw Compaction](https://docs.openclaw.ai/concepts/compaction)
- Local Hermes log observation: `/Users/a1/Desktop/claw/openbmb/hermesagent/.../agent.log` shows `Context compressor initialized` with `threshold=64000 (50%)`, `target_ratio=20%`, `tail_budget=12800`.
