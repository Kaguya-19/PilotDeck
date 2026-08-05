#!/usr/bin/env node

import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;

const CASES = [
  {
    id: "cron-origin-rejection",
    source: "src/adapters/channel/protocol/ImCronDelivery.ts",
    target: "tests/adapters/im-cron-delivery.spec.ts",
    name: "IM cron delivery reports transport rejection and propagates transport errors",
    mutation: (source) => replaceOnce(source,
      "return (await sendText(chatId, delivery.text)) !== false;",
      "await sendText(chatId, delivery.text);\n  return true;",
    ),
  },
  {
    id: "cron-session-key-validation",
    source: "src/adapters/channel/protocol/ImCronDelivery.ts",
    target: "tests/adapters/im-cron-delivery.spec.ts",
    name: "IM cron session keys require a channel match and a complete session suffix",
    mutation: (source) => replaceOnce(source,
      "/^(.+):(general|s_[0-9a-fA-F-]{36})$/",
      "/^(.+):(.+)$/",
    ),
  },
  {
    id: "renderer-tool-noise",
    source: "src/adapters/channel/weixin/weixin-render.ts",
    target: "tests/adapters/im-renderers.spec.ts",
    name: "IM renderers suppress tool start and successful tool completion noise",
    mutation: (source) => replaceOnce(source,
      'case "tool_call_started":\n      return "";',
      'case "tool_call_started":\n      return "tool started";',
    ),
  },
  {
    id: "feishu-elicitation-capture",
    source: "src/adapters/channel/feishu/FeishuChannel.ts",
    target: "tests/adapters/feishu-permission-reply.spec.ts",
    name: "Feishu webhook captures an elicitation and pairs the public reply with the Gateway request",
    mutation: (source) => replaceOnce(source,
      "const questionText = this.elicitation.capture(chatId, turn.sessionKey, event);",
      'const questionText = "elicitation not captured";',
    ),
  },
  {
    id: "weixin-permission-activity-delay",
    source: "src/adapters/channel/weixin/WeixinChannel.ts",
    target: "tests/adapters/weixin-lifecycle.spec.ts",
    name: "Weixin public poll delays permission activity until the configured timer fires",
    mutation: (source) => replaceOnce(source,
      'resumeActivity("tool", { immediate: false })',
      'resumeActivity("tool", { immediate: true })',
    ),
  },
  {
    id: "signal-receive-concurrency",
    source: "src/adapters/channel/signal/SignalChannel.ts",
    target: "tests/adapters/signal-stream-lifecycle.spec.ts",
    name: "Signal public SSE loop handles a permission answer while its turn is still pending",
    mutation: (source) => replaceOnce(source,
      "void this.parseLine(line).catch((e) => {",
      "await this.parseLine(line).catch((e) => {",
    ),
  },
  {
    id: "weixin-busy-queue",
    source: "src/adapters/channel/weixin/WeixinChannel.ts",
    target: "tests/adapters/weixin-lifecycle.spec.ts",
    name: "Weixin public poll drains busy messages FIFO and snapshots queued attachments",
    mutation: (source) => replaceOnce(source,
      'this.queuePendingTurn(fromUser, {\n        sessionKey: mapped.sessionKey,\n        message: mapped.message,\n        projectKey: mapped.projectKey,\n        attachments: extracted.attachments,\n      });',
      "return;",
    ),
  },
  {
    id: "weixin-content-length",
    source: "src/adapters/channel/weixin/WeixinChannel.ts",
    target: "tests/adapters/weixin-fetch-compat.spec.ts",
    name: "Weixin iLink fetch removes content-length without changing unrelated requests",
    mutation: (source) => replaceOnce(source,
      "const headers = stripContentLengthHeader(init.headers);",
      "const headers = init.headers;",
    ),
  },
  {
    id: "weixin-poll-rebuild",
    source: "src/adapters/channel/weixin/WeixinChannel.ts",
    target: "tests/adapters/weixin-lifecycle.spec.ts",
    name: "Weixin public poll rebuilds a recoverable client with the live cursor",
    mutation: (source) => replaceOnce(source,
      "this.rebuildClientAfterPollError(e);",
      "// client rebuild removed by mutation proof",
    ),
  },
  {
    id: "weixin-file-decryption",
    source: "src/adapters/channel/weixin/WeixinChannel.ts",
    target: "tests/adapters/weixin-lifecycle.spec.ts",
    name: "Weixin public poll decrypts a nested encrypted file before Gateway submission",
    mutation: (source) => replaceOnce(source,
      "transform: (buffer) => this.decryptWeixinFile(buffer, file),",
      "transform: (buffer) => buffer,",
    ),
  },
  {
    id: "weixin-qr-poll-start",
    source: "src/adapters/channel/weixin/WeixinChannel.ts",
    target: "tests/adapters/weixin-lifecycle.spec.ts",
    name: "Weixin starts polling when a background QR login completes after start returns",
    mutation: (source) => replaceOnce(source,
      "this.logger?.info?.(`weixin: login successful, accountId=${result.accountId}`);\n      this.startPollingWithCredentials(creds);",
      "this.logger?.info?.(`weixin: login successful, accountId=${result.accountId}`);",
    ),
  },
  {
    id: "weixin-assistant-attachment",
    source: "src/adapters/channel/weixin/WeixinChannel.ts",
    target: "tests/adapters/weixin-lifecycle.spec.ts",
    name: "Weixin public Gateway stream sends only explicit assistant_attachment events as media",
    mutation: (source) => replaceOnce(source,
      'if (event.type === "assistant_attachment") {\n          await this.sendAttachment(userId, event.attachment);\n          continue;\n        }',
      'if (event.type === "assistant_attachment") {\n          continue;\n        }',
    ),
  },
];

const args = process.argv.slice(2);
if (args.includes("--list")) {
  for (const item of CASES) console.log(`${item.id}\t${item.name}`);
  process.exit(0);
}
const requested = args.indexOf("--case") >= 0 ? args[args.indexOf("--case") + 1] : undefined;
const selected = requested ? CASES.filter((item) => item.id === requested) : CASES;
if (requested && selected.length === 0) {
  console.error(`unknown regression proof case: ${requested}`);
  process.exit(2);
}

const tempRoots = [];
try {
  const baseline = await createCopy("pilotdeck-regression-baseline-");
  tempRoots.push(baseline.root);
  await build(baseline.root, baseline.home);
  for (const item of CASES) {
    await runTarget(baseline.root, item, true, baseline.home);
  }
  console.log(`baseline: ${CASES.length} targeted tests passed`);

  for (const item of selected) {
    const copy = await createCopy(`pilotdeck-regression-${item.id}-`);
    tempRoots.push(copy.root);
    const sourcePath = join(copy.root, item.source);
    const before = await readFile(sourcePath, "utf8");
    const after = item.mutation(before);
    if (before === after) throw new Error(`${item.id}: mutation did not change the source`);
    await writeFile(sourcePath, after);
    await build(copy.root, copy.home);
    const result = await runTarget(copy.root, item, false, copy.home);
    if (!result.failed) throw new Error(`${item.id}: target test still passed after mutation\n${result.output ?? ""}`);
    console.log(`MUTATION_FAIL ${item.id}`);
  }
} finally {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
}

function replaceOnce(source, needle, replacement) {
  const index = source.indexOf(needle);
  if (index < 0) throw new Error("mutation needle was not found");
  if (source.indexOf(needle, index + needle.length) >= 0) {
    throw new Error("mutation needle matched more than one source location");
  }
  return `${source.slice(0, index)}${replacement}${source.slice(index + needle.length)}`;
}

async function createCopy(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const home = join(root, "pilot-home");
  await mkdir(home, { recursive: true });
  const output = await execFileAsync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: ROOT, encoding: "buffer" });
  const files = output.stdout.toString("utf8").split("\0").filter(Boolean);
  for (const file of files) {
    const destination = join(root, file);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(ROOT, file), destination);
  }
  await symlink(join(ROOT, "node_modules"), join(root, "node_modules"), "dir");
  await symlink(join(ROOT, "ui", "node_modules"), join(root, "ui", "node_modules"), "dir");
  return { root, home };
}

async function build(root, home) {
  await execFileAsync("pnpm", ["run", "build"], {
    cwd: root,
    env: { ...process.env, PILOT_HOME: home },
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function runTarget(root, item, expectPass, home) {
  const pattern = `^${item.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
  const result = await execFileAsync(NODE, [
    "--test", "--test-force-exit", "--test-timeout", "10000",
    "--test-name-pattern", pattern,
    `dist/${item.target.replace(/\.(ts|tsx)$/, ".js")}`,
  ], {
    cwd: root,
    env: { ...process.env, PILOT_HOME: home },
    maxBuffer: 16 * 1024 * 1024,
  }).catch((error) => ({ stdout: error.stdout ?? "", stderr: error.stderr ?? "", status: error.code ?? 1 }));
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const failed = (result.status ?? 0) !== 0
    && (output.match(/^not ok /gm) ?? []).length === 1
    && output.includes(item.name)
    && /# fail 1\b/.test(output)
    && /# cancelled 0\b/.test(output);
  if (expectPass && ((result.status ?? 0) !== 0 || !/# pass 1\b/.test(output))) {
    throw new Error(`baseline target failed: ${item.id}\n${output}`);
  }
  return { failed, output };
}
