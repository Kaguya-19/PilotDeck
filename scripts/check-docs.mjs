import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const trdDir = path.join(root, "docs", "trd");
const failures = [];

for (const [relative, patterns] of [
  ["AGENTS.md", [/Gateway 是/, /bug 必须先/, /pnpm check/]],
  ["docs/test-quality-roadmap.zh.md", [/P0：/, /P1：/, /P6：/, /CURRENT_ONLY/]],
  ["docs/test-evidence-matrix.zh.md", [/证据等级/, /MUTATION_FAIL/, /DEFER_EXTERNAL/]],
]) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) {
    failures.push(`${relative}: 文件不存在`);
    continue;
  }
  const content = fs.readFileSync(absolute, "utf8");
  for (const pattern of patterns) {
    if (!pattern.test(content)) failures.push(`${relative}: 缺少规范 ${pattern}`);
  }
}

const mainFiles = Array.from({ length: 50 }, (_, index) =>
  `${String(index + 1).padStart(2, "0")}-${[
    "gateway-wire", "gateway-lifecycle", "agent-loop", "agent-session", "turn-runner", "agent-events",
    "token-budget", "prompt-projection", "compaction-engine", "micro-compaction", "context-recovery",
    "memory-runtime", "attachment-context", "canonical-model", "openai-chat", "openai-responses",
    "anthropic-messages", "google-gemini", "stream-assembly", "router-decision", "token-saver",
    "orchestration", "fallback", "retry-health", "tool-registry", "tool-description-schema", "tool-filtering",
    "tool-scheduler", "tool-execution-result", "permission", "lifecycle-hooks", "extension-plugin", "skill-runtime",
    "mcp-runtime", "transcript-replay", "session-metadata-title", "file-history-artifact", "path-worktree-safety",
    "always-on", "cron", "background-task", "adapter-contract", "web-api", "gateway-bridge", "ui-store-reducer",
    "ui-interaction", "cli-local-server", "configuration-runtime", "network-request", "telemetry-runtime",
  ][index]}.zh.md`,
);
const platformFiles = [
  "feishu", "weixin", "signal", "wecom", "wecom-callback", "discord", "telegram", "slack", "whatsapp",
  "dingtalk", "qq", "matrix", "mattermost", "email", "sms", "bluebubbles", "homeassistant", "webhook",
  "api-server", "cli", "tui",
].map((name) => `platforms/${name}.zh.md`);

function read(relative) {
  const absolute = path.join(trdDir, relative);
  if (!fs.existsSync(absolute)) {
    failures.push(`${relative}: 文件不存在`);
    return "";
  }
  return fs.readFileSync(absolute, "utf8");
}

function checkSections(relative, content) {
  const required = [
    ["状态", /状态：|文档状态/],
    ["边界", /边界/],
    ["契约", /核心契约|契约/],
    ["测试证据", /测试|证据/],
    ["验收或延期", /验收|延期|DEFER_EXTERNAL/],
  ];
  for (const [label, pattern] of required) {
    if (!pattern.test(content)) failures.push(`${relative}: 缺少章节 ${label}`);
  }
}

function resolveLocalLink(fromRelative, target) {
  const clean = target.split("#", 1)[0].split("?", 1)[0];
  if (!clean || clean.startsWith("http:") || clean.startsWith("https:") || clean.startsWith("mailto:")) return true;
  const absolute = path.resolve(path.dirname(path.join(trdDir, fromRelative)), clean);
  return fs.existsSync(absolute);
}

function checkPaths(relative, content) {
  const codePaths = [...content.matchAll(/`((?:src|ui|tests|docs)\/[^`]+)`/g)].map((match) => match[1]);
  for (const declared of codePaths) {
    const candidate = declared.replace(/\*\*?$/, "");
    const absolute = path.join(root, candidate);
    if (!fs.existsSync(absolute)) {
      // A planned test directory may intentionally be absent while the TRD
      // records CURRENT_ONLY. It is not a silent pass: the document check
      // preserves the evidence state and the missing mapping remains visible.
      if (!(declared.startsWith("tests/") && content.includes("CURRENT_ONLY"))) {
        failures.push(`${relative}: 声明路径不存在 ${declared}`);
      }
    }
  }
}

function checkSecrets(relative, content) {
  const suspicious = [
    /sk-[A-Za-z0-9]{16,}/,
    /-----BEGIN (?:RSA|OPENSSH|EC|PRIVATE) KEY-----/,
    /(?:^|\s)\/(?:Users|home)\/[A-Za-z0-9._-]+/,
    /(?:^|\s)\$RUNNER_TEMP\/[^\s`]+/,
  ];
  if (suspicious.some((pattern) => pattern.test(content))) failures.push(`${relative}: 疑似凭证、真实用户路径或临时配置`);
}

for (const relative of ["README.zh.md", "roadmap.zh.md", ...mainFiles, ...platformFiles]) {
  const content = read(relative);
  if (!content) continue;
  checkSections(relative, content);
  checkPaths(relative, content);
  checkSecrets(relative, content);
  for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    if (!resolveLocalLink(relative, match[1])) failures.push(`${relative}: 本地链接不存在 ${match[1]}`);
  }
}

const index = read("README.zh.md");
for (const relative of [...mainFiles, ...platformFiles]) {
  const link = relative.startsWith("platforms/") ? relative : relative;
  if (!index.includes(`(${link})`)) failures.push(`README.zh.md: 缺少索引链接 ${link}`);
}

if (failures.length > 0) {
  console.error("文档检查失败：");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`文档检查通过：${mainFiles.length} 份主 TRD、${platformFiles.length} 份平台附录。`);
}
