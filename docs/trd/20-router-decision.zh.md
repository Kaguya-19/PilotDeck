# Router Decision TRD

状态：评审中　维护者：Router 团队

## 代码边界

覆盖 `src/router/RouterRuntime.ts`、scenario、model catalog、explicit override 和 session sticky。

## 核心契约

- explicit model override 只影响当前 turn。
- Router 决策不得修改原始 user message 或 transcript。
- sticky 仅按 session/project 正确隔离，并可在 turn 结束时失效。
- capability、context window 和 model availability 必须参与决策。

## 测试

映射 `tests/router/router-runtime.spec.ts`、`tests/router/router-core.spec.ts`、`tests/router/scenario-and-policy.spec.ts`、`tests/router/token-stats-collector.spec.ts`、`tests/router/tokenSaver.spec.ts` 和 context-cap tests。新增 RouterRuntime 入口测试覆盖 disabled passthrough、explicit/custom/subagent 决策、sticky/invalidate、cache-aware switching、media reroute/downgrade、live stream、fallback、transient/mid-stream retry、provider error、abort 和 subagent budget。`RouterRuntime.ts` 当前行覆盖率 `93.73%`、函数覆盖率 `87.23%`，证据为 `CURRENT_ONLY`；模型冲突、unavailable model 和 health skip 的 mutation proof 仍待补充。

## 验收

相同输入、配置和 session 状态产生可解释决策；失败返回稳定 Router error。
