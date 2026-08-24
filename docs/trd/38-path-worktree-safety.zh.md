# Path and Worktree Safety TRD

状态：评审中　维护者：File Safety 团队

## 代码边界

覆盖 `src/pilot/paths.ts`、`src/session/worktree/**`、workspace/project path validation 和 attachment path checks。

## 核心契约

- 规范化路径必须位于授权 root 内。
- 拒绝 `..`、相似前缀逃逸、symlink 越界、绝对路径伪装和 Windows 跨盘符路径。
- project/worktree identity 不得因相似路径碰撞。
- editor load failure 不得授权空内容覆盖原文件。

## 测试

映射 path safety、workspace ID、editor、file history 和 adapter web tests。使用 `path.win32` table tests 和临时目录，不依赖平台账号。

## 验收

Unix、Windows path table、symlink、collision、read-only root 和 failed load 均有拒绝断言。
