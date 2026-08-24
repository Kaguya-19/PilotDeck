import assert from "node:assert/strict";
import test from "node:test";
import {
  NetworkFetchError,
  isRetryableNetworkCode,
  jitteredBackoff,
  networkFetch,
  networkFetchJson,
  networkPostJson,
  normalizeNetworkError,
} from "../../src/network/fetch.js";

function response(status: number, headers: Record<string, string> = {}): Response {
  return new Response("{}", { status, headers });
}

test("networkFetch retries retryable status responses and then succeeds", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return calls === 1 ? response(500) : response(200);
  };

  const result = await networkFetch("https://example.test", {}, {
    fetchImpl,
    retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 },
  });

  assert.equal(result.status, 200);
  assert.equal(calls, 2);
});

test("networkFetch uses retry-after when calculating retry delay", () => {
  assert.equal(jitteredBackoff(0, { baseDelayMs: 1, maxDelayMs: 10_000 }, "2"), 2000);
});

test("networkFetch caps retry-after delays with maxDelayMs", () => {
  assert.equal(jitteredBackoff(0, { baseDelayMs: 1, maxDelayMs: 5_000 }, "3600"), 5000);
});

test("networkFetch normalizes DNS and reset errors", () => {
  assert.equal(normalizeNetworkError(Object.assign(new Error("getaddrinfo ENOTFOUND api.test"), { code: "ENOTFOUND" })).code, "network_dns_error");
  assert.equal(normalizeNetworkError(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })).code, "network_connection_reset");
});

test("networkFetch times out requests", async () => {
  const fetchImpl: typeof fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });

  await assert.rejects(
    networkFetch("https://example.test", {}, { fetchImpl, timeoutMs: 1 }),
    { code: "network_timeout" },
  );
});

test("networkFetch honors init.signal abort reasons without options.signal", async () => {
  const controller = new AbortController();
  const reason = new NetworkFetchError("network_timeout", "outer timeout");
  const fetchImpl: typeof fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    controller.abort(reason);
  });

  await assert.rejects(
    networkFetch("https://example.test", { signal: controller.signal }, { fetchImpl }),
    { code: "network_timeout" },
  );
});

test("networkFetch preserves parent NetworkFetchError reasons passed through options.signal", async () => {
  const controller = new AbortController();
  const reason = new NetworkFetchError("network_timeout", "configured timeout");
  const fetchImpl: typeof fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    controller.abort(reason);
  });

  await assert.rejects(
    networkFetch("https://example.test", {}, { fetchImpl, signal: controller.signal }),
    { code: "network_timeout" },
  );
});

test("networkFetch retries transport errors for safe methods but not POST unless explicitly enabled", async () => {
  let getCalls = 0;
  const getResult = await networkFetch("https://example.test", {}, {
    fetchImpl: async () => {
      getCalls += 1;
      if (getCalls === 1) throw Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" });
      return response(200);
    },
    retry: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0 },
  });
  assert.equal(getResult.status, 200);
  assert.equal(getCalls, 2);

  let postCalls = 0;
  await assert.rejects(networkFetch("https://example.test", { method: "POST" }, {
    fetchImpl: async () => {
      postCalls += 1;
      throw Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" });
    },
    retry: { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 },
  }), { code: "network_connection_reset" });
  assert.equal(postCalls, 1);
});

test("networkFetch retries POST via networkPostJson and accepts configured status lists", async () => {
  let calls = 0;
  const result = await networkPostJson<{ ok: boolean }>("https://example.test", { value: 1 }, {}, {
    fetchImpl: async (_input, init) => {
      calls += 1;
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init?.headers).get("content-type"), "application/json");
      return calls === 1 ? response(409) : new Response('{"ok":true}', { status: 201 });
    },
    retry: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0 },
    expectedStatuses: [201],
  });
  assert.deepEqual(result.json, { ok: true });
  assert.equal(calls, 2);
});

test("networkFetchJson normalizes HTTP and JSON decoding failures", async () => {
  await assert.rejects(networkFetchJson("https://example.test", {}, {
    fetchImpl: async () => new Response("rate limited", { status: 429, statusText: "Too Many" }),
  }), { code: "network_rate_limited" });
  await assert.rejects(networkFetchJson("https://example.test", {}, {
    fetchImpl: async () => new Response("server failed", { status: 503, statusText: "Unavailable" }),
  }), { code: "network_server_error" });
  await assert.rejects(networkFetchJson("https://example.test", {}, {
    fetchImpl: async () => new Response("bad request", { status: 400, statusText: "Bad Request" }),
  }), { code: "network_fetch_failed" });
  await assert.rejects(networkFetchJson("https://example.test", {}, {
    fetchImpl: async () => new Response("not json", { status: 200 }),
  }), { code: "network_fetch_failed" });
  const accepted = await networkFetchJson<{ accepted: true }>("https://example.test", {}, {
    fetchImpl: async () => new Response('{"accepted":true}', { status: 202 }),
    expectedStatuses: [202],
  });
  assert.deepEqual(accepted.json, { accepted: true });
});

test("normalizeNetworkError maps provider, signal, and transport codes", () => {
  const cases: Array<[string, string]> = [
    ["ECONNREFUSED", "network_connection_refused"],
    ["ETIMEDOUT", "network_timeout"],
    ["certificate verify failed", "network_tls_error"],
    ["proxy connection failed", "network_proxy_error"],
    ["request aborted", "network_abort"],
    ["unexpected", "network_fetch_failed"],
  ];
  for (const [message, code] of cases) {
    assert.equal(normalizeNetworkError(new Error(message)).code, code);
  }
  assert.equal(normalizeNetworkError({ cause: { code: "EAI_AGAIN" } }).code, "network_dns_error");
  const parent = new AbortController();
  parent.abort("stop");
  assert.equal(normalizeNetworkError(new Error("ignored"), undefined, parent.signal).code, "network_abort");
  const local = new AbortController();
  local.abort("deadline");
  assert.equal(normalizeNetworkError(new Error("ignored"), local.signal).code, "network_timeout");
  assert.equal(isRetryableNetworkCode("network_fetch_failed"), true);
  assert.equal(isRetryableNetworkCode("network_abort"), false);
  assert.equal(isRetryableNetworkCode("network_tls_error"), false);
});

test("networkFetch aborts a pending retry and resolves Request methods", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(networkFetch(new Request("https://example.test", { method: "HEAD" }), {}, {
    signal: controller.signal,
    fetchImpl: async () => {
      calls += 1;
      controller.abort("stop retry");
      return response(500);
    },
    retry: { maxRetries: 1, baseDelayMs: 50, maxDelayMs: 50 },
  }), { code: "network_abort" });
  assert.equal(calls, 1);
});
