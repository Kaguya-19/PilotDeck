import assert from "node:assert/strict";
import test from "node:test";

import {
  createLongTimeoutOptions,
  getGlobalProxyStateForTesting,
  getProxyUrl,
  installGlobalProxy,
  reinstallGlobalProxy,
} from "../../src/cli/proxy.js";
import { createShutdownAndExit } from "../../src/cli/shutdownCoordinator.js";

test("shutdown coordinator coalesces concurrent exits and keeps the highest code", async () => {
  let release!: () => void;
  let stopCount = 0;
  const exits: number[] = [];
  const stopping = new Promise<void>((resolve) => { release = resolve; });
  const shutdown = createShutdownAndExit(async () => {
    stopCount += 1;
    await stopping;
  }, (code) => exits.push(code));

  const first = shutdown(1);
  const second = shutdown(3);
  const third = shutdown(2);
  assert.equal(first, second);
  assert.equal(second, third);
  assert.equal(stopCount, 1);
  release();
  await Promise.all([first, second, third]);
  assert.deepEqual(exits, [3]);
  await shutdown(0);
  assert.deepEqual(exits, [3]);
});

test("proxy URL selection follows explicit environment priority", () => {
  assert.equal(getProxyUrl({ PILOTDECK_PROXY: "pilot", HTTPS_PROXY: "https", HTTP_PROXY: "http" }), "pilot");
  assert.equal(getProxyUrl({ https_proxy: "lower", HTTPS_PROXY: "upper", HTTP_PROXY: "http" }), "lower");
  assert.equal(getProxyUrl({ HTTPS_PROXY: "upper", HTTP_PROXY: "http" }), "upper");
  assert.equal(getProxyUrl({ HTTP_PROXY: "http" }), "http");
  assert.equal(getProxyUrl({}), undefined);
});

test("proxy install records direct and explicit proxy states and stable transport limits", async (t) => {
  t.after(async () => {
    await reinstallGlobalProxy(undefined);
  });
  const limits = createLongTimeoutOptions();
  assert.ok(limits.headersTimeout > 0);
  assert.equal(limits.headersTimeout, limits.bodyTimeout);
  assert.ok(limits.connections > 0);

  assert.equal(await installGlobalProxy(""), undefined);
  assert.deepEqual(getGlobalProxyStateForTesting(), { mode: "direct" });
  assert.equal(await installGlobalProxy("http://proxy.invalid:8080", "internal.test"), "http://proxy.invalid:8080");
  const state = getGlobalProxyStateForTesting();
  assert.equal(state?.mode, "proxy");
  if (state?.mode === "proxy") {
    assert.equal(state.source, "config");
    assert.equal(state.proxyUrl, "http://proxy.invalid:8080");
    assert.match(state.noProxy, /127\.0\.0\.1/);
    assert.match(state.noProxy, /localhost/);
    assert.match(state.noProxy, /internal\.test/);
  }
  assert.equal(await installGlobalProxy("http://proxy.invalid:8080", "internal.test"), undefined);
});
