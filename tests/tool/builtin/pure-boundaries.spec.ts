import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createGetCurrentTimeTool } from "../../../src/tool/builtin/getCurrentTime.js";
import { createListMcpResourcesTool, createReadMcpResourceTool } from "../../../src/tool/builtin/mcpResources.js";
import { globPatternToRegExp } from "../../../src/tool/builtin/filesystem/globPattern.js";
import { walkFiles } from "../../../src/tool/builtin/filesystem/walk.js";
import {
  clearWebFetchCache,
  URL_CACHE,
} from "../../../src/tool/builtin/web/urlContentCache.js";
import {
  __setWebFetchHookForTesting,
  getURLMarkdownContent,
  truncateMarkdown,
} from "../../../src/tool/builtin/web/urlFetcher.js";
import {
  isPermittedRedirect,
  upgradeHttpToHttps,
  validateURL,
} from "../../../src/tool/builtin/web/urlValidation.js";

test("URL validation rejects malformed, credentialed and non-DNS URLs", () => {
  assert.equal(validateURL("https://example.com/path"), true);
  assert.equal(validateURL("http://www.example.com/path"), true);
  assert.equal(validateURL("https://localhost/path"), false);
  assert.equal(validateURL("https://127.0.0.1/path"), false);
  assert.equal(validateURL("https://user:pass@example.com/path"), false);
  assert.equal(validateURL("not a url"), false);
  assert.equal(validateURL(`https://example.com/${"x".repeat(2_000)}`), false);

  const upgraded = upgradeHttpToHttps("http://example.com/a");
  assert.equal(upgraded.upgraded, "https://example.com/a");
  assert.equal(upgraded.parsed.protocol, "https:");
  assert.equal(upgradeHttpToHttps("https://example.com/a").upgraded, "https://example.com/a");

  assert.equal(isPermittedRedirect("https://example.com/a", "https://example.com/b"), true);
  assert.equal(isPermittedRedirect("https://example.com/a", "https://www.example.com/b"), true);
  assert.equal(isPermittedRedirect("https://example.com/a", "http://example.com/b"), false);
  assert.equal(isPermittedRedirect("https://example.com:8443/a", "https://example.com/b"), false);
  assert.equal(isPermittedRedirect("https://example.com/a", "https://user@example.com/b"), false);
  assert.equal(isPermittedRedirect("invalid", "https://example.com/b"), false);
});

test("URL cache updates LRU entries, removes oversized entries and clears state", () => {
  clearWebFetchCache();
  const first = { bytes: 1, code: 200, codeText: "OK", content: "first", contentType: "text/plain" };
  const second = { bytes: 2, code: 200, codeText: "OK", content: "second", contentType: "text/plain" };
  URL_CACHE.set("https://example.com/one", first, 10);
  assert.deepEqual(URL_CACHE.get("https://example.com/one"), first);
  URL_CACHE.set("https://example.com/one", second, 20);
  assert.deepEqual(URL_CACHE.get("https://example.com/one"), second);
  URL_CACHE.set("https://example.com/huge", first, 60 * 1024 * 1024);
  assert.equal(URL_CACHE.get("https://example.com/huge"), undefined);
  URL_CACHE.set("https://example.com/large-a", first, 40 * 1024 * 1024);
  URL_CACHE.set("https://example.com/large-b", second, 20 * 1024 * 1024);
  assert.equal(URL_CACHE.get("https://example.com/large-a"), undefined);
  assert.deepEqual(URL_CACHE.get("https://example.com/large-b"), second);
  const realNow = Date.now;
  try {
    const start = realNow();
    Date.now = () => start;
    URL_CACHE.set("https://example.com/expiry", first, 1);
    Date.now = () => start + 15 * 60 * 1000;
    assert.equal(URL_CACHE.get("https://example.com/expiry"), undefined);
  } finally {
    Date.now = realNow;
  }
  clearWebFetchCache();
  assert.equal(URL_CACHE.get("https://example.com/one"), undefined);
});

test("get_current_time formats a fixed instant and rejects invalid timezones", async () => {
  const tool = createGetCurrentTimeTool();
  const output = await tool.execute({ timezone: "Asia/Shanghai" }, {
    now: () => new Date("2026-08-24T00:00:00.000Z"),
  } as never);
  assert.equal(output.data?.timezone, "Asia/Shanghai");
  assert.equal(output.data?.iso, "2026-08-24T00:00:00.000Z");
  assert.equal(output.data?.local, "2026-08-24T08:00:00+08:00");
  assert.equal(output.data?.date, "2026-08-24");
  assert.equal(output.data?.weekday, "Monday");
  assert.equal(output.data?.unixMs, 1_787_529_600_000);
  await assert.rejects(
    () => tool.execute({ timezone: "Not/A_Timezone" }, { now: () => new Date() } as never),
    (error: unknown) => error instanceof Error && /Invalid timezone/.test(error.message),
  );
});

test("MCP resource tools fail closed without an adapter and return adapter values", async () => {
  const list = createListMcpResourcesTool();
  const read = createReadMcpResourceTool();
  assert.equal(list.isReadOnly?.(), true);
  assert.equal(list.isConcurrencySafe?.(), true);
  assert.equal(list.isOpenWorld?.(), true);
  assert.equal(read.isReadOnly?.(), true);
  assert.equal(read.isConcurrencySafe?.(), true);
  assert.equal(read.isOpenWorld?.(), true);
  await assert.rejects(() => list.execute({}, {} as never), /MCP resource adapter is not configured/);
  await assert.rejects(() => read.execute({ serverId: "s", uri: "u" }, {} as never), /MCP resource adapter is not configured/);

  const calls: string[] = [];
  const adapter = {
    listResources: async (serverId?: string) => { calls.push(`list:${serverId ?? "all"}`); return [{ uri: "memory://one" }]; },
    readResource: async (serverId: string, uri: string) => { calls.push(`read:${serverId}:${uri}`); return { text: "content" }; },
  };
  const listOutput = await createListMcpResourcesTool(adapter).execute({ serverId: "server" }, {} as never);
  const readOutput = await createReadMcpResourceTool(adapter).execute({ serverId: "server", uri: "memory://one" }, {} as never);
  assert.deepEqual(listOutput.data, [{ uri: "memory://one" }]);
  assert.deepEqual(readOutput.data, { text: "content" });
  assert.deepEqual(calls, ["list:server", "read:server:memory://one"]);
});

test("glob patterns and workspace walking preserve path boundaries", async (t) => {
  assert.equal(globPatternToRegExp("src/**/*.ts").test("src/a.ts"), true);
  assert.equal(globPatternToRegExp("src/**/*.ts").test("src/nested/a.ts"), true);
  assert.equal(globPatternToRegExp("src/*.ts").test("src/nested/a.ts"), false);
  assert.equal(globPatternToRegExp("file?.[jt]s").test("file1.js"), false);

  const root = await mkdtemp(join(tmpdir(), "pilotdeck-walk-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src", "nested"), { recursive: true });
  await mkdir(join(root, ".git"), { recursive: true });
  await mkdir(join(root, "node_modules"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "a", "utf8");
  await writeFile(join(root, "src", "nested", "b.ts"), "b", "utf8");
  await writeFile(join(root, ".git", "ignored"), "x", "utf8");
  await writeFile(join(root, "node_modules", "ignored"), "x", "utf8");
  assert.deepEqual(await walkFiles(root), ["src/a.ts", "src/nested/b.ts"]);
});

test("web fetch uses a controlled transport for text, cache, binary, redirects and errors", async (t) => {
  t.after(() => {
    __setWebFetchHookForTesting(null);
    clearWebFetchCache();
  });
  clearWebFetchCache();
  const requested: string[] = [];
  __setWebFetchHookForTesting(async (url) => {
    requested.push(url);
    if (url.endsWith("/text")) {
      return response(200, "hello\nworld", "text/plain");
    }
    if (url.endsWith("/binary")) {
      return response(200, "\u0000\u0001", "application/octet-stream");
    }
    if (url.endsWith("/redirect")) {
      return { status: 302, statusText: "Found", headers: { location: "https://example.com/final" }, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    if (url.endsWith("/final")) return response(200, "redirected", "text/plain");
    if (url.endsWith("/bad-redirect")) {
      return { status: 302, statusText: "Found", headers: { location: "https://other.example/final" }, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    if (url.endsWith("/error")) return response(429, "too many", "text/plain", { "retry-after": "3" });
    if (url.endsWith("/proxy")) return response(403, "blocked", "text/plain", { "x-proxy-error": "blocked-by-allowlist" });
    if (url.endsWith("/html")) return response(200, "<h1>Hello</h1><p>world</p>", "text/html; charset=utf-8");
    if (url.endsWith("/empty-error")) return response(500, "", "text/plain");
    if (url.endsWith("/binary-error")) return response(500, "\u0000\u0001", "application/pdf");
    if (url.endsWith("/too-large")) {
      const body = new Uint8Array(10 * 1024 * 1024 + 1);
      return { status: 200, statusText: "OK", headers: { "content-type": "text/plain" }, arrayBuffer: async () => body.buffer };
    }
    if (url.endsWith("/missing-location")) return response(302, "", "text/plain");
    const redirectMatch = /\/r(\d+)$/.exec(new URL(url).pathname);
    if (redirectMatch) {
      const next = Number(redirectMatch[1]) + 1;
      return { status: 302, statusText: "Found", headers: { location: `https://example.com/r${next}` }, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    return response(200, "fallback", "text/plain");
  });

  const text = await getURLMarkdownContent("http://example.com/text", new AbortController().signal);
  assert.equal(text.fromCache, false);
  assert.equal("content" in text ? text.content : undefined, "hello\nworld");
  const cached = await getURLMarkdownContent("http://example.com/text", new AbortController().signal);
  assert.equal("fromCache" in cached ? cached.fromCache : false, true);
  assert.deepEqual(requested, ["https://example.com/text"]);

  const binary = await getURLMarkdownContent("https://example.com/binary", new AbortController().signal);
  assert.match("content" in binary ? binary.content : "", /Binary application\/octet-stream/);
  const html = await getURLMarkdownContent("https://example.com/html", new AbortController().signal);
  assert.match("content" in html ? html.content : "", /Hello/);
  const redirect = await getURLMarkdownContent("https://example.com/redirect", new AbortController().signal);
  assert.equal("type" in redirect ? redirect.type : undefined, undefined);
  assert.equal("content" in redirect ? redirect.content : undefined, "redirected");
  const disallowed = await getURLMarkdownContent("https://example.com/bad-redirect", new AbortController().signal);
  assert.deepEqual(disallowed, {
    type: "redirect",
    originalUrl: "https://example.com/bad-redirect",
    redirectUrl: "https://other.example/final",
    statusCode: 302,
  });
  await assert.rejects(
    () => getURLMarkdownContent("https://example.com/error", new AbortController().signal),
    (error: unknown) => error instanceof Error && /HTTP 429/.test(error.message) && (error as { retryAfterMs?: number }).retryAfterMs === 3_000,
  );
  await assert.rejects(
    () => getURLMarkdownContent("https://example.com/empty-error", new AbortController().signal),
    (error: unknown) => error instanceof Error && error.name === "WebFetchHttpError" && (error as { bodyPreview?: string }).bodyPreview === undefined,
  );
  await assert.rejects(
    () => getURLMarkdownContent("https://example.com/binary-error", new AbortController().signal),
    (error: unknown) => error instanceof Error && /Binary application\/pdf/.test(String((error as { bodyPreview?: string }).bodyPreview)),
  );
  await assert.rejects(
    () => getURLMarkdownContent("https://example.com/too-large", new AbortController().signal),
    /maximum content length/,
  );
  await assert.rejects(
    () => getURLMarkdownContent("https://example.com/missing-location", new AbortController().signal),
    /Redirect missing Location/,
  );
  await assert.rejects(
    () => getURLMarkdownContent("https://example.com/r0", new AbortController().signal),
    /Too many redirects/,
  );
  await assert.rejects(
    () => getURLMarkdownContent("https://example.com/proxy", new AbortController().signal),
    /EGRESS_BLOCKED/,
  );
  await assert.rejects(() => getURLMarkdownContent("https://localhost/no", new AbortController().signal), /Invalid URL/);
  assert.equal(truncateMarkdown("short"), "short");
  assert.match(truncateMarkdown("x".repeat(100_001)), /Content truncated due to length/);
});

function response(status: number, text: string, contentType: string, extraHeaders: Record<string, string> = {}) {
  const body = Buffer.from(text, "utf8");
  return {
    status,
    statusText: status === 200 ? "OK" : status === 429 ? "Too Many Requests" : "Forbidden",
    headers: { "content-type": contentType, ...extraHeaders },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}
