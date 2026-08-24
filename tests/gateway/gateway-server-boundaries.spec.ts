import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import WebSocket from "ws";

import { startGatewayServer } from "../../src/gateway/server/GatewayServer.js";
import type { Gateway } from "../../src/gateway/protocol/types.js";
import { PILOTDECK_GATEWAY_PROTOCOL_VERSION } from "../../src/gateway/protocol/version.js";

function gateway(): Gateway {
  return {
    describeServer: async () => ({ mode: "test", capabilities: [] }),
    async *submitTurn() {},
  } as unknown as Gateway;
}

function nextFrame(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      socket.off("error", onError);
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    };
    const onError = (error: Error) => {
      socket.off("message", onMessage);
      reject(error);
    };
    socket.once("message", onMessage);
    socket.once("error", onError);
  });
}

async function openAndHello(serverUrl: string, token: string): Promise<WebSocket> {
  const socket = new WebSocket(`${serverUrl.replace(/^http/, "ws")}/ws`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({
    type: "hello",
    protocolVersion: PILOTDECK_GATEWAY_PROTOCOL_VERSION,
    clientName: "test",
    clientVersion: "test",
    token,
  }));
  assert.equal((await nextFrame(socket)).type, "hello_ok");
  return socket;
}

test("GatewayServer rejects non-loopback hosts before creating a listener", async () => {
  await assert.rejects(startGatewayServer({ gateway: gateway(), host: "0.0.0.0", port: 0, token: "token" }), /only supports localhost/);
});

test("GatewayServer handles Feishu webhook, static fallback, 404 and broadcast notifications", async (t) => {
  const staticRoot = await mkdtemp(join(tmpdir(), "pilotdeck-server-static-"));
  t.after(() => rm(staticRoot, { recursive: true, force: true }));
  await writeFile(join(staticRoot, "index.html"), "<html>test</html>");
  let webhookBody = "";
  const server = await startGatewayServer({
    gateway: gateway(),
    port: 0,
    token: "token",
    staticAssetsPath: staticRoot,
    feishuWebhook: async (_request, response, body) => {
      webhookBody = body;
      response.writeHead(204);
      response.end();
      return true;
    },
  });
  t.after(() => server.close().catch(() => undefined));

  const webhook = await fetch(`${server.url}/feishu/webhook`, { method: "POST", body: "{\"challenge\":\"ok\"}" });
  assert.equal(webhook.status, 204);
  assert.equal(webhookBody, "{\"challenge\":\"ok\"}");
  const staticResponse = await fetch(`${server.url}/unknown-ui-route`);
  assert.equal(staticResponse.status, 200);
  assert.equal(await staticResponse.text(), "<html>test</html>");
  const missing = await fetch(`${server.url}/no-static-root`);
  assert.equal(missing.status, 200, "SPA fallback serves index for unknown routes");
  const noStaticServer = await startGatewayServer({ gateway: gateway(), port: 0, token: "token" });
  t.after(() => noStaticServer.close().catch(() => undefined));
  assert.equal((await fetch(`${noStaticServer.url}/missing`)).status, 404);

  const socket = await openAndHello(server.url, "token");
  const notification = nextFrame(socket);
  server.broadcastNotification("config_changed", { paths: ["agent.model"] });
  assert.deepEqual(await notification, { type: "notification", name: "config_changed", payload: { paths: ["agent.model"] } });
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.close();
  await closed;
});

test("GatewayServer lets an unhandled Feishu webhook continue to the 404 route", async (t) => {
  const server = await startGatewayServer({
    gateway: gateway(),
    port: 0,
    token: "token",
    feishuWebhook: () => false,
  });
  t.after(() => server.close().catch(() => undefined));
  const response = await fetch(`${server.url}/feishu/webhook`, { method: "POST", body: "ignored" });
  assert.equal(response.status, 404);
  assert.equal(await response.text(), "not found");
});
