import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { GatewayWsClient } from "../../src/gateway/client/GatewayWsClient.js";
import { createProjectId } from "../../src/pilot/index.js";
import { resolveGatewayTokenPath } from "../../src/gateway/server/authToken.js";

const execFileAsync = promisify(execFile);
const enabled = process.env.PILOTDECK_RUN_REAL_LEGAL_E2E === "1";
const apiKey = process.env.PILOTDECK_E2E_API_KEY?.trim();

test("real legal data loop uses env-enabled storage across upload, agent and subagent turns", {
  skip: !enabled || !apiKey ? "Set PILOTDECK_RUN_REAL_LEGAL_E2E=1 and PILOTDECK_E2E_API_KEY to run." : false,
  timeout: 15 * 60_000,
}, async (t) => {
  assert.ok(apiKey);
  if (Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) !== 22) {
    t.skip("Project runtime requires Node 22.x.");
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "pilotdeck-legal-e2e-"));
  const pilotHome = join(root, "pilot-home");
  const projectRoot = join(root, "project");
  const storageRoot = join(root, "legal-storage");
  const sourceFile = join(projectRoot, "legal-cases.xlsx");
  const outputFile = join(projectRoot, "整理结果.xlsx");
  const gatewayPort = 28789 + Math.floor(Math.random() * 1000);
  const serverPort = gatewayPort + 1;
  const env = {
    ...process.env,
    PILOT_HOME: pilotHome,
    PILOTDECK_CONFIG_PATH: join(pilotHome, "pilotdeck.yaml"),
    PILOTDECK_E2E_API_KEY: apiKey,
    PILOTDECK_LEGAL_STORAGE_ROOT: storageRoot,
    PILOTDECK_LEGAL_STORAGE_CONFIG_VERSION: "e2e",
    PILOTDECK_GATEWAY_PORT: String(gatewayPort),
    SERVER_PORT: String(serverPort),
    PILOTDECK_DISABLE_LOCAL_AUTH: "1",
    PILOTDECK_GATEWAY_URL: `ws://127.0.0.1:${gatewayPort}/ws`,
  };
  let runtime: ChildProcess | undefined;
  let output = "";

  try {
    await mkdir(join(pilotHome, "projects", createProjectId(projectRoot)), { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    await writeFile(join(pilotHome, "projects", createProjectId(projectRoot), ".cwd"), `${projectRoot}\n`);
    await writeFile(join(pilotHome, "pilotdeck.yaml"), buildConfig());
    await createXlsx(sourceFile);

    runtime = spawn(process.execPath, ["--import", "tsx", "ui/server/webRuntimeSupervisor.js", "start-built"], {
      cwd: resolve(dirname(new URL(import.meta.url).pathname), "../.."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    runtime.stdout?.on("data", (chunk) => { output += String(chunk); });
    runtime.stderr?.on("data", (chunk) => { output += String(chunk); });

    try {
      await waitForHttp(`http://127.0.0.1:${gatewayPort}/health`);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output.slice(-4000)}`);
    }
    await waitForHttp(`http://127.0.0.1:${serverPort}/api/auth/status`);

    const upload = await uploadFile(`http://127.0.0.1:${serverPort}`, projectRoot, sourceFile);
    const token = (await readFile(resolveGatewayTokenPath({ pilotHome }), "utf8")).trim();
    const client = new GatewayWsClient({
      url: `ws://127.0.0.1:${gatewayPort}/ws`,
      token,
      clientName: "web",
    });
    await client.connect();
    t.after(() => client.close());

    const first = await collectTurn(client, {
      sessionKey: "legal-e2e-read",
      projectKey: projectRoot,
      uploadedAttachments: [{ uploadId: upload.uploadId }],
      message: "请读取附件中的法律案件表，提取案件编号、客户名称、金额和风险等级，并用中文总结。",
    });
    assert.equal(first.finishReason, "completed");
    assert.match(first.text, /案件|客户|金额|风险/);

    const beforeRepeat = await inspectStorage(storageRoot);
    const repeated = await collectTurn(client, {
      sessionKey: "legal-e2e-read-repeat",
      projectKey: projectRoot,
      uploadedAttachments: [{ uploadId: upload.uploadId }],
      message: "请再次读取附件并用一句话总结案件数量和最高风险等级。",
    });
    assert.equal(repeated.finishReason, "completed");
    const afterRepeat = await inspectStorage(storageRoot);
    assert.equal(afterRepeat.md5Objects, beforeRepeat.md5Objects, "identical workspace content should reuse MD5 objects");

    const second = await collectTurn(client, {
      sessionKey: "legal-e2e-subagent",
      projectKey: projectRoot,
      uploadedAttachments: [{ uploadId: upload.uploadId }],
      message: "请使用 subagent 整理附件中的法律案件数据，生成整理结果.xlsx，保留原始字段并增加风险说明列。完成后告诉我输出文件路径。",
    });
    assert.equal(second.finishReason, "completed");
    await stat(outputFile);

    const successfulStorage = await inspectStorage(storageRoot);
    assert.ok(successfulStorage.workspaceIds.includes(createProjectId(projectRoot)), `expected PilotDeck workspace storage ID ${createProjectId(projectRoot)}, got ${successfulStorage.workspaceIds.join(", ")}`);
    assert.ok(successfulStorage.preUser >= 3, `expected pre_user snapshots, got ${successfulStorage.preUser}`);
    assert.equal(successfulStorage.postAgent, 0, "successful turns must not create post_agent snapshots");

    const providerError = await collectTurn(client, {
      sessionKey: "legal-e2e-provider-error",
      projectKey: projectRoot,
      modelOverride: { provider: "llm-center", model: "claude-sonnet-5-invalid" },
      message: "请读取附件并总结。",
    });
    assert.notEqual(providerError.finishReason, "completed");

    const timedOut = await collectTurn(client, {
      sessionKey: "legal-e2e-timeout",
      projectKey: projectRoot,
      timeoutMs: 100,
      message: "请详细分析附件中的所有案件。",
    });
    assert.notEqual(timedOut.finishReason, "completed");

    const storage = await waitForStorage(storageRoot, (current) => current.invocations.length > 0 && current.postAgent >= 2);
    assert.ok(storage.preUser >= 2, `expected pre_user snapshots, got ${storage.preUser}`);
    assert.ok(storage.postAgent >= 2, `error and timeout turns should create post_agent snapshots, got ${storage.postAgent}`);
    assert.ok(storage.invocations.length > 0, "expected invocation logs");
    assert.ok(storage.invocations.some((item) => item.caller === "agent"));
    assert.ok(storage.invocations.some((item) => item.caller === "subagent"));
    assert.ok(storage.invocations.every((item) => !JSON.stringify(item).includes(apiKey)));
    assert.ok(storage.md5Objects >= 1);

    const aborted = await startAndAbort(client, {
      sessionKey: "legal-e2e-abort",
      projectKey: projectRoot,
      message: "请长时间分析附件中的每一行并逐项写出详细法律风险说明。",
    });
    assert.notEqual(aborted.finishReason, "completed");
    const afterAbort = await waitForStorage(storageRoot, (current) => current.postAgent >= 3);
    assert.ok(afterAbort.postAgent >= 3, `provider error, timeout and abort should create post_agent snapshots, got ${afterAbort.postAgent}`);

    assert.ok(!output.includes(apiKey), "the model API key must not appear in server output");
  } finally {
    runtime?.kill("SIGTERM");
    await new Promise<void>((resolveDone) => {
      if (!runtime || runtime.exitCode !== null) return resolveDone();
      runtime.once("exit", () => resolveDone());
      setTimeout(resolveDone, 10_000).unref();
    });
    await rm(root, { recursive: true, force: true });
  }
});

async function collectTurn(client: GatewayWsClient, input: Record<string, unknown>): Promise<{ text: string; finishReason?: string }> {
  let text = "";
  let finishReason: string | undefined;
  for await (const event of client.stream("submit_turn", {
    channelKey: "web",
    workspaceId: "ignored-client-value",
    ...input,
  })) {
    if (event.type === "assistant_text_delta") text += event.text;
    if (event.type === "turn_completed") finishReason = event.finishReason;
  }
  return { text, finishReason };
}

async function startAndAbort(client: GatewayWsClient, input: Record<string, unknown>): Promise<{ finishReason?: string }> {
  const sessionKey = String(input.sessionKey);
  const stream = client.stream("submit_turn", {
    channelKey: "web",
    workspaceId: "ignored-client-value",
    ...input,
  });
  let runId: string | undefined;
  let finishReason: string | undefined;
  for await (const event of stream) {
    runId ??= event.runId;
    if (event.type === "model_request_started" && runId) {
      await client.request("abort_turn", { sessionKey, runId, reason: "legal-e2e-abort" });
    }
    if (event.type === "turn_completed") finishReason = event.finishReason;
  }
  return { finishReason };
}

async function uploadFile(baseUrl: string, projectRoot: string, filePath: string): Promise<{ uploadId: string }> {
  const bytes = await readFile(filePath);
  const create = await fetch(`${baseUrl}/api/uploads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectKey: projectRoot,
      files: [{ clientFileId: "source", name: "legal-cases.xlsx", relativePath: "legal-cases.xlsx", size: bytes.byteLength }],
    }),
  });
  const createBody = await create.text();
  assert.equal(create.ok, true, createBody);
  const created = JSON.parse(createBody) as { uploadId: string; contentUrl?: string };
  const form = new FormData();
  form.append("files[source]", new Blob([bytes]), "legal-cases.xlsx");
  const content = await fetch(`${baseUrl}${created.contentUrl ?? `/api/uploads/${created.uploadId}/content`}`, { method: "POST", body: form });
  const contentBody = await content.text();
  assert.equal(content.ok, true, contentBody);
  return { uploadId: created.uploadId };
}

async function inspectStorage(root: string): Promise<{ preUser: number; postAgent: number; invocations: Array<Record<string, unknown>>; md5Objects: number; workspaceIds: string[] }> {
  const workspacesRoot = join(root, "workspaces");
  const workspaceIds = await readdir(workspacesRoot).catch(() => []);
  let preUser = 0;
  let postAgent = 0;
  const invocations: Array<Record<string, unknown>> = [];
  for (const workspaceId of workspaceIds) {
    const workspaceRoot = join(workspacesRoot, workspaceId, "sessions");
    for (const session of await readdir(workspaceRoot).catch(() => [])) {
      const snapshotRoot = join(workspaceRoot, session, "snapshots");
      for (const snapshot of await readdir(snapshotRoot).catch(() => [])) {
        const marker = await stat(join(snapshotRoot, snapshot, "_COMMITTED")).catch(() => undefined);
        if (!marker) continue;
        const manifest = JSON.parse(await readFile(join(snapshotRoot, snapshot, "manifest.json"), "utf8")) as { phase?: string };
        if (manifest.phase === "pre_user") preUser += 1;
        if (manifest.phase === "post_agent") postAgent += 1;
      }
      const log = await readFile(join(workspaceRoot, session, "llm", "invocations.jsonl"), "utf8").catch(() => "");
      for (const line of log.split("\n").filter(Boolean)) invocations.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  const first = await readdir(join(root, "objects", "md5")).catch(() => []);
  let md5Objects = 0;
  for (const prefix of first) {
    for (const next of await readdir(join(root, "objects", "md5", prefix)).catch(() => [])) {
      md5Objects += (await readdir(join(root, "objects", "md5", prefix, next)).catch(() => [])).length;
    }
  }
  return { preUser, postAgent, invocations, md5Objects, workspaceIds };
}

async function waitForStorage(
  root: string,
  predicate: (current: Awaited<ReturnType<typeof inspectStorage>>) => boolean,
): Promise<Awaited<ReturnType<typeof inspectStorage>>> {
  const deadline = Date.now() + 15_000;
  let current = await inspectStorage(root);
  while (!predicate(current) && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    current = await inspectStorage(root);
  }
  return current;
}

async function waitForHttp(url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* process is still starting */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function createXlsx(path: string): Promise<void> {
  const script = [
    "import sys, zipfile",
    "p=sys.argv[1]",
    "files={'[Content_Types].xml':'<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/><Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/></Types>',",
    "'_rels/.rels':'<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>',",
    "'xl/_rels/workbook.xml.rels':'<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/></Relationships>',",
    "'xl/workbook.xml':'<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets><sheet name=\"案件\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>',",
    "'xl/worksheets/sheet1.xml':'<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData><row r=\"1\"><c r=\"A1\" t=\"inlineStr\"><is><t>案件编号</t></is></c><c r=\"B1\" t=\"inlineStr\"><is><t>客户名称</t></is></c><c r=\"C1\" t=\"inlineStr\"><is><t>金额</t></is></c><c r=\"D1\" t=\"inlineStr\"><is><t>风险等级</t></is></c></row><row r=\"2\"><c r=\"A2\" t=\"inlineStr\"><is><t>CASE-001</t></is></c><c r=\"B2\" t=\"inlineStr\"><is><t>星河科技</t></is></c><c r=\"C2\"><v>1200000</v></c><c r=\"D2\" t=\"inlineStr\"><is><t>高</t></is></c></row></sheetData></worksheet>'}",
    "with zipfile.ZipFile(p,'w',zipfile.ZIP_DEFLATED) as z:\n  [z.writestr(k,v) for k,v in files.items()]",
  ].join("\n");
  await execFileAsync("python3", ["-c", script, path]);
}

function buildConfigWithObjectDefault(): string {
  return `schemaVersion: 1\nagent:\n  model: llm-center/claude-sonnet-5\n  subagents:\n    default:\n      provider: llm-center\n      model: claude-sonnet-5\nmodel:\n  providers:\n    llm-center:\n      protocol: anthropic\n      url: https://llm-center.modelbest.co/v1\n      apiKey: \"\${PILOTDECK_E2E_API_KEY}\"\n      models:\n        claude-sonnet-5: {}\nrouter:\n  enabled: false\n`;
}

function buildConfig(): string {
  return [
    "schemaVersion: 1",
    "agent:",
    "  model: llm-center/claude-sonnet-5",
    "  subagents:",
    "    default: llm-center/claude-sonnet-5",
    "model:",
    "  providers:",
    "    llm-center:",
    "      protocol: anthropic",
    "      url: https://llm-center.modelbest.co/v1",
    "      apiKey: \"${PILOTDECK_E2E_API_KEY}\"",
      "      models:",
      "        claude-sonnet-5: {}",
      "        claude-sonnet-5-invalid: {}",
    "router:",
    "  enabled: false",
    "",
  ].join("\n");
}
