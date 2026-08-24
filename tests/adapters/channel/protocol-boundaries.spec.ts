import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  executeChannelCommand,
  getRegisteredCommands,
  resolveCommand,
} from "../../../src/adapters/channel/protocol/ChannelCommandRegistry.js";
import { ChannelStatePersistence } from "../../../src/adapters/channel/protocol/ChannelStatePersistence.js";
import { ImAttachmentDelivery, formatImAttachmentFallback, guessMimeTypeFromName } from "../../../src/adapters/channel/protocol/ImAttachmentDelivery.js";
import { ImAttachmentStore, isPathWithinDirectory } from "../../../src/adapters/channel/protocol/ImAttachmentStore.js";
import { ImChatSessionState } from "../../../src/adapters/channel/protocol/ImChatSessionState.js";
import { deliverChatCronResult, parseChatIdFromSessionKey } from "../../../src/adapters/channel/protocol/ImCronDelivery.js";
import { ImElicitationHelper } from "../../../src/adapters/channel/protocol/ImElicitationHelper.js";
import { ImPermissionHelper } from "../../../src/adapters/channel/protocol/ImPermissionHelper.js";
import type { Gateway } from "../../../src/gateway/index.js";

function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function gateway(overrides: Record<string, unknown> = {}): Gateway {
  return {
    listProjects: async () => ({ projects: [] }),
    permissionDecide: async () => ({ delivered: true }),
    respondElicitation: async () => ({ delivered: true }),
    ...overrides,
  } as unknown as Gateway;
}

async function withFakeCommands<T>(
  scripts: Record<string, string>,
  run: () => Promise<T>,
): Promise<T> {
  const root = await tempDir("pilotdeck-channel-commands-");
  const previousPath = process.env.PATH;
  try {
    for (const [name, body] of Object.entries(scripts)) {
      const path = join(root, name);
      await writeFile(path, `#!/bin/sh\nset -e\n${body}\n`, "utf8");
      await chmod(path, 0o755);
    }
    process.env.PATH = `${root}:${previousPath ?? ""}`;
    return await run();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
}

function commandContext(overrides: Partial<Parameters<typeof executeChannelCommand>[1]> = {}) {
  const replies: string[] = [];
  const context = {
    gateway: gateway(),
    chatId: "chat",
    channelKey: "test",
    reply: async (text: string) => { replies.push(text); },
    ...overrides,
  } as Parameters<typeof executeChannelCommand>[1];
  return { context, replies };
}

test("ChannelStatePersistence flushes debounced state and survives missing files", async (t) => {
  const root = await tempDir("pilotdeck-channel-state-");
  t.after(() => rm(root, { recursive: true, force: true }));

  const persistence = new ChannelStatePersistence({ stateDir: root, debounceMs: 60_000 });
  assert.equal(await persistence.load("missing"), undefined);
  persistence.save("feishu", { projectKey: "project-a", session: 1 });
  persistence.save("feishu", { projectKey: "project-b", session: 2 });
  persistence.save("weixin", { session: 3 });
  await persistence.flush();

  assert.deepEqual(await persistence.load("feishu"), { projectKey: "project-b", session: 2 });
  assert.deepEqual(await persistence.load("weixin"), { session: 3 });
  assert.match(await readFile(join(root, "feishu.state.json"), "utf8"), /project-b/);
});

test("ChannelStatePersistence keeps the newest value during overlapping flushes", async (t) => {
  const root = await tempDir("pilotdeck-channel-state-overlap-");
  t.after(() => rm(root, { recursive: true, force: true }));

  const persistence = new ChannelStatePersistence({ stateDir: root, debounceMs: 60_000 });
  persistence.save("same", { revision: 1 });
  const firstFlush = persistence.flush();
  persistence.save("same", { revision: 2 });
  await Promise.all([firstFlush, persistence.flush()]);
  assert.deepEqual(await persistence.load("same"), { revision: 2 });
});

test("ImAttachmentStore enforces limits, transforms data and normalizes image names", async (t) => {
  const root = await tempDir("pilotdeck-attachment-store-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: Array<{ url: string; signal: AbortSignal; headers?: HeadersInit }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, signal: init?.signal as AbortSignal, headers: init?.headers });
    return new Response(Buffer.from("ignored"), {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });
  };
  const store = new ImAttachmentStore({ rootDir: root, channelKey: "weixin/channel", maxBytes: 32, fetchImpl });

  await assert.rejects(
    store.saveFromUrl({ url: "https://example.invalid/large", chatId: "chat", messageId: "m", type: "file", bytes: 33 }),
    /33 bytes/,
  );
  const saved = await store.saveFromUrl({
    url: "https://example.invalid/file",
    headers: { authorization: "test" },
    chatId: "chat/one",
    messageId: "message:one",
    type: "file",
    name: "report",
    mimeType: "text/plain",
    metadata: { source: "unit" },
    transform: (buffer) => Buffer.concat([buffer, Buffer.from("!")]),
  });
  assert.equal(saved.name, "report.txt");
  assert.equal(saved.mimeType, "text/plain");
  assert.equal(saved.bytes, 8);
  assert.deepEqual(saved.metadata, {
    channelKey: "weixin/channel",
    chatId: "chat/one",
    messageId: "message:one",
    sourceUrl: "https://example.invalid/file",
    source: "unit",
  });
  assert.equal((await stat(saved.path)).mode & 0o777, 0o600);
  assert.equal(calls[0]?.headers !== undefined, true);
  assert.equal(calls[0]?.signal.aborted, false);

  const png = await new ImAttachmentStore({ rootDir: root, channelKey: "images", maxBytes: 32, fetchImpl: async () => new Response(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    { status: 200, headers: { "content-type": "application/octet-stream" } },
  ) }).saveFromUrl({
    url: "https://example.invalid/image",
    chatId: "chat",
    messageId: "image",
    type: "image",
    name: "unsafe/filename.jpg",
    mimeType: "image/jpeg",
  });
  assert.equal(png.name, "filename.png");
  assert.equal(png.mimeType, "image/png");
});

test("ImAttachmentStore rejects HTTP, content-length and transformed-size failures", async (t) => {
  const root = await tempDir("pilotdeck-attachment-errors-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const makeStore = (response: Response) => new ImAttachmentStore({
    rootDir: root,
    channelKey: "test",
    maxBytes: 4,
    fetchImpl: async () => response,
  });
  await assert.rejects(
    makeStore(new Response("no", { status: 500 })).saveFromUrl({ url: "u", chatId: "c", messageId: "m", type: "file" }),
    /HTTP 500/,
  );
  await assert.rejects(
    makeStore(new Response("ok", { status: 200, headers: { "content-length": "5" } })).saveFromUrl({ url: "u", chatId: "c", messageId: "m", type: "file" }),
    /content-length|5 bytes/,
  );
  await assert.rejects(
    makeStore(new Response("ok", { status: 200 })).saveFromUrl({
      url: "u", chatId: "c", messageId: "m", type: "file", transform: () => Buffer.from("12345"),
    }),
    /5 bytes/,
  );
});

test("ImAttachmentStore path and MIME helpers cover platform boundaries", () => {
  assert.equal(isPathWithinDirectory("/root/a", "/root"), true);
  assert.equal(isPathWithinDirectory("/root", "/root"), true);
  assert.equal(isPathWithinDirectory("/rooted/a", "/root"), false);
  assert.equal(isPathWithinDirectory("/root/../escape", "/root"), false);
  assert.equal(guessMimeTypeFromName("photo.PNG"), "image/png");
  assert.equal(guessMimeTypeFromName("report.jpeg"), "image/jpeg");
  assert.equal(guessMimeTypeFromName("animation.gif"), "image/gif");
  assert.equal(guessMimeTypeFromName("photo.webp"), "image/webp");
  assert.equal(guessMimeTypeFromName("manual.pdf"), "application/pdf");
  assert.equal(guessMimeTypeFromName("note.txt"), "text/plain");
  assert.equal(guessMimeTypeFromName("readme.md"), "text/markdown");
  assert.equal(guessMimeTypeFromName("data.json"), "application/json");
  assert.equal(guessMimeTypeFromName("unknown.bin"), undefined);
});

test("ImAttachmentStore detects supported image signatures and fallback extensions", async (t) => {
  const root = await tempDir("pilotdeck-attachment-signatures-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const samples: Array<{ bytes: number[]; mime: string; name: string }> = [
    { bytes: [0xff, 0xd8, 0xff, 0x00], mime: "image/jpeg", name: "x.bin" },
    { bytes: [...Buffer.from("GIF87a"), 0x00], mime: "image/gif", name: "x.gif" },
    { bytes: [...Buffer.from("GIF89a"), 0x00], mime: "image/gif", name: "x.gif" },
    { bytes: [...Buffer.from("RIFFxxxxWEBP")], mime: "image/webp", name: "x.webp" },
    { bytes: [0x01, 0x02], mime: "image/custom", name: "x.custom" },
  ];
  for (const [index, sample] of samples.entries()) {
    const store = new ImAttachmentStore({
      rootDir: root,
      channelKey: `images-${index}`,
      maxBytes: 64,
      fetchImpl: async () => new Response(Buffer.from(sample.bytes), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }),
    });
    const result = await store.saveFromUrl({
      url: `https://example.invalid/${index}`,
      chatId: "chat",
      messageId: "message",
      type: "image",
      name: sample.name,
      mimeType: sample.mime,
    });
    assert.equal(result.mimeType, sample.mime);
    const extension = sample.mime === "image/jpeg" ? "jpg"
      : sample.mime === "image/png" ? "png"
        : sample.mime === "image/gif" ? "gif"
          : sample.mime === "image/webp" ? "webp" : "bin";
    assert.equal(result.name.endsWith(`.${extension}`), true);
  }
});

test("ImAttachmentDelivery sends content, reads files, and falls back safely", async (t) => {
  const root = await tempDir("pilotdeck-attachment-delivery-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const local = join(root, "unsafe.txt");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(local, "local", "utf8"));
  const prepared: unknown[] = [];
  const fallbacks: string[] = [];
  const errors: string[] = [];
  const delivery = new ImAttachmentDelivery({
    maxBytes: 32,
    sendPrepared: async (attachment) => prepared.push(attachment),
    sendTextFallback: async (text) => fallbacks.push(text),
    logger: { error: (message) => errors.push(message) },
  });

  assert.equal(await delivery.send({ source: "gateway", type: "image", name: "a.png", content: Buffer.from("png").toString("base64") }), true);
  assert.equal(await delivery.send({ source: "gateway", type: "file", path: local, name: "local.txt" }), true);
  assert.equal(await delivery.send({ source: "local_path", type: "file", path: local }), false);
  assert.equal(await delivery.send({ source: "gateway", type: "file", name: "too.txt", content: Buffer.alloc(33).toString("base64") }), false);
  assert.equal(prepared.length, 2);
  assert.equal(fallbacks.length, 2);
  assert.equal(errors.length, 1);
  assert.match(fallbacks[0]!, /需要授权/);
  assert.match(fallbacks[1]!, /too.txt/);
  assert.equal(formatImAttachmentFallback({ source: "gateway", type: "file", path: "/tmp/a.txt" }), "附件发送失败：a.txt，可在本机查看：/tmp/a.txt");
});

test("ImChatSessionState bounds queues and invalidates old generations", () => {
  const state = new ImChatSessionState({ maxPendingTurns: 2 });
  const first = { sessionKey: "s", message: "one", attachments: [] };
  state.queueTurn("chat", first);
  state.queueTurn("chat", { ...first, message: "two" });
  state.queueTurn("chat", { ...first, message: "three" });
  assert.equal(state.shiftTurn("chat")?.message, "two");
  assert.equal(state.shiftTurn("chat")?.message, "three");
  assert.equal(state.shiftTurn("chat"), undefined);
  state.setActiveRun("chat", { sessionKey: "s", runId: "run", generation: 0 });
  assert.equal(state.activeRun("chat")?.runId, "run");
  state.resetForNewSession("chat");
  assert.equal(state.generation("chat"), 1);
  assert.equal(state.isCurrent("chat", 1), true);
  assert.equal(state.activeRun("chat"), undefined);
  state.clearActiveRun("chat");
});

test("Cron delivery only targets matching channel and valid session keys", async () => {
  assert.equal(parseChatIdFromSessionKey("feishu:chat=abc:general", "feishu"), "abc");
  assert.equal(parseChatIdFromSessionKey("feishu:chat=abc:s_123e4567-e89b-12d3-a456-426614174000", "feishu"), "abc");
  assert.equal(parseChatIdFromSessionKey("weixin:chat=abc:general", "feishu"), undefined);
  assert.equal(parseChatIdFromSessionKey("feishu:chat=abc:bad", "feishu"), undefined);
  const sent: string[] = [];
  const delivery = { sessionKey: "feishu:chat=chat-1:general", text: "cron" };
  assert.equal(await deliverChatCronResult(delivery, "feishu", (chatId, text) => { sent.push(`${chatId}:${text}`); }), true);
  assert.deepEqual(sent, ["chat-1:cron"]);
  assert.equal(await deliverChatCronResult({ ...delivery, originChannelKey: "weixin" }, "feishu", () => true), false);
  assert.equal(await deliverChatCronResult({ ...delivery, sessionKey: "feishu:chat=chat-1:bad" }, "feishu", () => true), false);
  assert.equal(await deliverChatCronResult(delivery, "feishu", () => false), false);
});

test("IM elicitation and permission helpers map replies and preserve invalid pending state", async () => {
  const elicitation = new ImElicitationHelper();
  const elicitationAnswers: unknown[] = [];
  const elicitationGateway = gateway({ respondElicitation: async (input: unknown) => { elicitationAnswers.push(input); return { delivered: true }; } });
  const prompt = elicitation.capture("chat", "session", {
    type: "elicitation_request",
    requestId: "request",
    questions: [{ header: "Choose", question: "Which?", options: [{ label: "A", description: "first" }, { label: "B", description: "second" }], multiSelect: true }],
  });
  assert.match(prompt, /Choose/);
  assert.match(prompt, /1\. A — first/);
  assert.equal(await elicitation.answer("chat", "1, 2", elicitationGateway), undefined);
  assert.deepEqual(elicitationAnswers[0], { sessionKey: "session", requestId: "request", answer: { type: "answered", answers: { "Which?": ["A", "B"] } } });

  elicitation.capture("chat", "session", { type: "elicitation_request", requestId: "cancel", questions: [{ header: "", question: "Q", options: [{ label: "Yes", description: "" }] }] });
  assert.equal(await elicitation.answer("chat", "0", elicitationGateway), "已取消。");
  assert.equal(elicitation.hasPending("chat"), false);
  elicitation.clear("chat");

  const permission = new ImPermissionHelper();
  const decisions: unknown[] = [];
  const permissionGateway = gateway({ permissionDecide: async (input: unknown) => { decisions.push(input); return { delivered: true }; } });
  permission.capture("chat", "session", { type: "permission_request", requestId: "p", toolName: "read_file", payload: { path: "a" } });
  assert.equal(await permission.answer("chat", "bad", permissionGateway), "请回复 1 允许一次，回复 2 允许本会话，回复 0 拒绝。");
  assert.equal(permission.hasPending("chat"), true);
  assert.equal(await permission.answer("chat", "2", permissionGateway), "已允许本会话，继续执行。");
  assert.deepEqual(decisions, [{ sessionKey: "session", requestId: "p", decision: "allow", remember: true }]);
  permission.capture("chat", "session", { type: "permission_request", requestId: "deny", toolName: "write", payload: {} });
  assert.equal(await permission.answer("chat", "0", permissionGateway), "已拒绝，继续处理。");
  permission.clear("chat");
});

test("ImPermissionHelper formats deny, multi-request and malformed payload branches", async () => {
  const helper = new ImPermissionHelper();
  const decisions: unknown[] = [];
  const gatewayInstance = gateway({ permissionDecide: async (input: unknown) => { decisions.push(input); return { delivered: true }; } });
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const long = "x".repeat(900);
  const first = helper.capture("chat", "session", {
    type: "permission_request",
    requestId: "deny-1",
    toolName: "write_file",
    payload: circular,
  });
  assert.match(first, /write_file/);
  assert.match(first, /\[object Object\]/);
  helper.capture("chat", "session", {
    type: "permission_request",
    requestId: "deny-2",
    toolName: "write_file",
    payload: long,
  });
  assert.equal(await helper.answer("chat", "0", gatewayInstance), "已拒绝 2 个待处理权限请求，继续处理。");
  assert.deepEqual(decisions, [
    { sessionKey: "session", requestId: "deny-1", decision: "deny", reason: "User denied permission from IM channel." },
    { sessionKey: "session", requestId: "deny-2", decision: "deny", reason: "User denied permission from IM channel." },
  ]);
  assert.equal(await helper.answer("chat", "1", gatewayInstance), undefined);
});

test("channel command registry resolves aliases and executes safe system commands", async () => {
  assert.equal(resolveCommand("hello"), undefined);
  assert.deepEqual(resolveCommand(" /项目列表 ")?.arg, "");
  assert.equal(resolveCommand("/plan")?.command.systemLevel, false);
  assert.equal(resolveCommand("/new")?.command.handler, undefined);
  assert.ok(getRegisteredCommands().some((command) => command.name === "help"));

  const replies: string[] = [];
  const ctx = { gateway: gateway(), chatId: "chat", channelKey: "feishu", reply: async (text: string) => replies.push(text) };
  assert.equal(await executeChannelCommand("/help", ctx), true);
  assert.match(replies[0]!, /可用命令/);
  assert.equal(await executeChannelCommand("/plan", ctx), false);
  assert.equal(await executeChannelCommand("not a command", ctx), false);

  const projectReplies: string[] = [];
  const projectCtx = {
    ...ctx,
    gateway: gateway({ listProjects: async () => ({ projects: [{ name: "Pilot", projectKey: "p", fullPath: "/tmp/p" }] }) }),
    reply: async (text: string) => projectReplies.push(text),
    bindProject: (key: string) => projectReplies.push(`bound:${key}`),
    resetSession: () => projectReplies.push("reset"),
  };
  await executeChannelCommand("/projects", projectCtx);
  await executeChannelCommand("/switch-project pilot", projectCtx);
  await executeChannelCommand("/switch-project missing", projectCtx);
  assert.match(projectReplies.join("\n"), /Pilot/);
  assert.match(projectReplies.join("\n"), /bound:p/);
  assert.match(projectReplies.join("\n"), /未找到匹配/);
});

test("channel command registry handles empty project and command failures", async () => {
  const errors: string[] = [];
  const { context: emptyProjects, replies } = commandContext({
    gateway: gateway({ listProjects: async () => ({ projects: [] }) }),
    logger: { error: (message: string) => errors.push(message) },
  });
  assert.equal(await executeChannelCommand("/projects", emptyProjects), true);
  assert.match(replies.at(-1)!, /暂无项目/);
  assert.equal(await executeChannelCommand("/switch-project", emptyProjects), true);
  assert.match(replies.at(-1)!, /用法/);

  const failing = commandContext({
    gateway: gateway({ listProjects: async () => { throw new Error("project store unavailable"); } }),
    logger: { error: (message: string) => errors.push(message) },
  });
  assert.equal(await executeChannelCommand("/projects", failing.context), true);
  assert.match(failing.replies.at(-1)!, /命令执行失败: project store unavailable/);
  assert.match(errors.at(-1)!, /command \/projects failed/);
});

test("channel command registry checks updates through a controlled git command", async () => {
  const scripts = {
    git: `
      if [ "\${FAKE_GIT_MODE:-latest}" = "fail" ]; then
        echo "git unavailable" >&2
        exit 7
      fi
      case "$1 $2 $3" in
        "branch --show-current ") printf 'feat/test\\n' ;;
        "fetch origin feat/test") : ;;
        "rev-parse HEAD ") printf 'local123456789\\n' ;;
        "rev-parse origin/feat/test ")
          if [ "\${FAKE_GIT_MODE:-latest}" = "behind" ]; then printf 'remote987654321\\n'; else printf 'local123456789\\n'; fi ;;
        "rev-list --count HEAD..origin/feat/test") printf '2\\n' ;;
        "log --oneline HEAD..origin/feat/test") printf 'abc123 first change\\ndef456 second change\\n' ;;
        "log --oneline -1") printf 'abc123 current change\\n' ;;
        *) exit 8 ;;
      esac
    `,
  };
  const previousMode = process.env.FAKE_GIT_MODE;
  const restoreMode = () => {
    if (previousMode === undefined) delete process.env.FAKE_GIT_MODE;
    else process.env.FAKE_GIT_MODE = previousMode;
  };
  try {
    await withFakeCommands(scripts, async () => {
      const latest = commandContext();
      process.env.FAKE_GIT_MODE = "latest";
      assert.equal(await executeChannelCommand("/update check", latest.context), true);
      assert.match(latest.replies.join("\n"), /已是最新版本/);

      const behind = commandContext();
      process.env.FAKE_GIT_MODE = "behind";
      await executeChannelCommand("/update check", behind.context);
      assert.match(behind.replies.join("\n"), /有 2 个新提交/);
      assert.match(behind.replies.join("\n"), /abc123 first change/);

      const failed = commandContext();
      process.env.FAKE_GIT_MODE = "fail";
      await executeChannelCommand("/update check", failed.context);
      assert.match(failed.replies.join("\n"), /检查更新失败/);
    });
  } finally {
    restoreMode();
  }
});

test("channel command registry reports status and update outcomes", async () => {
  const scripts = {
    git: `
      case "$1 $2 $3" in
        "branch --show-current ") printf 'main\\n' ;;
        "log --oneline -1") printf 'abc123 current change\\n' ;;
        *) exit 8 ;;
      esac
    `,
    bash: `
      case "\${FAKE_BASH_MODE:-success}" in
        already) printf 'already latest\\n' >&2; exit 2 ;;
        fail) printf 'build exploded\\n' >&2; exit 9 ;;
        *) printf 'build complete\\n' ;;
      esac
    `,
  };
  const previousMode = process.env.FAKE_BASH_MODE;
  const restoreMode = () => {
    if (previousMode === undefined) delete process.env.FAKE_BASH_MODE;
    else process.env.FAKE_BASH_MODE = previousMode;
  };
  try {
    await withFakeCommands(scripts, async () => {
      const status = commandContext();
      await executeChannelCommand("/status", status.context);
      assert.match(status.replies.join("\n"), /PilotDeck Status/);
      assert.match(status.replies.join("\n"), /分支: main/);

      const statusFailure = commandContext();
      await withFakeCommands({
        git: "echo status-failed >&2\nexit 3",
      }, async () => executeChannelCommand("/status", statusFailure.context));
      assert.match(statusFailure.replies.at(-1)!, /获取状态失败/);

      process.env.FAKE_BASH_MODE = "already";
      const already = commandContext();
      await executeChannelCommand("/update", already.context);
      assert.match(already.replies.at(-1)!, /已是最新版本/);

      process.env.FAKE_BASH_MODE = "fail";
      const failed = commandContext();
      await executeChannelCommand("/update", failed.context);
      assert.match(failed.replies.at(-1)!, /更新失败/);
      assert.match(failed.replies.at(-1)!, /build exploded/);

      const exitCodes: Array<number | undefined> = [];
      const originalExit = process.exit;
      const originalSetTimeout = globalThis.setTimeout;
      process.exit = ((code?: number) => { exitCodes.push(code); }) as typeof process.exit;
      globalThis.setTimeout = ((callback: (...args: never[]) => void, ...args: never[]) => {
        callback(...args);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout;
      try {
        process.env.FAKE_BASH_MODE = "success";
        const succeeded = commandContext();
        await executeChannelCommand("/update", succeeded.context);
        assert.match(succeeded.replies.at(-1)!, /更新完成/);
        assert.deepEqual(exitCodes, [0]);
      } finally {
        process.exit = originalExit;
        globalThis.setTimeout = originalSetTimeout;
      }
    });
  } finally {
    restoreMode();
  }
});
