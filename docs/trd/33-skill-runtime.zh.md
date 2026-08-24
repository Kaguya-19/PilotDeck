# Skill Runtime TRD

状态：评审中　维护者：Extension 团队

## 代码边界

覆盖 `src/extension/skills/**`、SkillManager、skill loader、迁移和 prompt 渲染。

## 核心契约

- skill 按 builtin/user/project/plugin scope 隔离。
- 同名 skill 的优先级和稳定排序必须明确。
- 加载失败返回结构化 not found/invalid 错误，不静默使用空 prompt。
- skill prompt 只能注入当前 turn，并保留来源 metadata。

## 测试

映射 skill tests、`tests/context/prompt-skill-path.spec.ts`、command discovery tests。补充 scope collision、migration、missing fixture 和 prompt injection。

## 验收

slash command、read_skill、skill migration 和 project isolation 可离线复现。
