import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ChannelAdapter, FeishuChannel } from "../../src/adapters/index.js";
import { startPilotDeckServer } from "../../src/cli/pilotdeckServer.js";
import type { Gateway } from "../../src/gateway/index.js";

type ChannelFixture = {
  channel: ChannelAdapter;
  starts: number;
  stops: string[];
};

function createChannel(
  channelKey: ChannelAdapter["channelKey"],
  options: { failStart?: boolean; deliver?: boolean; stuckStart?: boolean } = {},
): ChannelFixture {
  const fixture: ChannelFixture = {
    starts: 0,
    stops: [],
    channel: undefined as never,
  };
  fixture.channel = {
    channelKey,
    async start() {
      fixture.starts += 1;
      if (options.failStart) throw new Error(`${channelKey} candidate failed`);
      if (options.stuckStart) return new Promise(() => undefined);
      return {
        async stop(reason) {
          fixture.stops.push(reason ?? "");
        },
      };
    },
    deliverCronResult: options.deliver ? () => true : undefined,
  };
  return fixture;
}

async function withServer(t: test.TestContext, options: { feishu?: FeishuChannel } = {}) {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-channel-lifecycle-"));
  const previousPilotHome = process.env.PILOT_HOME;
  process.env.PILOT_HOME = pilotHome;
  const server = await startPilotDeckServer({ gateway: {} as Gateway, port: 0, ...options });
  t.after(async () => {
    await server.close();
    if (previousPilotHome === undefined) delete process.env.PILOT_HOME;
    else process.env.PILOT_HOME = previousPilotHome;
    await rm(pilotHome, { recursive: true, force: true });
  });
  return server;
}

test("channel reconciliation stops removed adapters and replaces only desired keys", async (t) => {
  const server = await withServer(t);
  const oldTelegram = createChannel("telegram");
  const discord = createChannel("discord");
  const replacementTelegram = createChannel("telegram", { deliver: true });
  await server.hotStartChannel(oldTelegram.channel);
  await server.hotStartChannel(discord.channel);

  const result = await server.reconcileChannels({
    channels: [replacementTelegram.channel],
    managedChannelKeys: ["telegram", "discord"],
  });

  assert.deepEqual(result, { started: ["telegram"], stopped: ["discord"] });
  assert.deepEqual(oldTelegram.stops, ["hot-reload"]);
  assert.deepEqual(discord.stops, ["config-disabled"]);
  assert.equal(replacementTelegram.starts, 1);
  assert.equal(await server.deliverCronResult({ channelKey: "telegram" } as never), true);
});

test("failed replacement restores the previous channel adapter", async (t) => {
  const server = await withServer(t);
  const previous = createChannel("telegram", { deliver: true });
  const failing = createChannel("telegram", { failStart: true });
  await server.hotStartChannel(previous.channel);

  await assert.rejects(server.hotStartChannel(failing.channel), /telegram candidate failed/);

  assert.equal(previous.starts, 2);
  assert.deepEqual(previous.stops, ["hot-reload"]);
  assert.equal(failing.starts, 1);
  assert.equal(await server.deliverCronResult({ channelKey: "telegram" } as never), true);
});

test("Feishu webhook follows replacement and rejects requests after removal", async (t) => {
  const server = await withServer(t);
  const events: string[] = [];
  const oldChannel = createChannel("feishu");
  const nextChannel = createChannel("feishu");
  const oldFeishu = Object.assign(oldChannel.channel, {
    async handleWebhook(_request: unknown, response: { end(value: string): void }, body: string) {
      events.push(`old:${body}`);
      response.end("old");
      return true;
    },
  }) as FeishuChannel;
  const nextFeishu = Object.assign(nextChannel.channel, {
    async handleWebhook(_request: unknown, response: { end(value: string): void }, body: string) {
      events.push(`next:${body}`);
      response.end("next");
      return true;
    },
  }) as FeishuChannel;

  await server.hotStartChannel(oldFeishu);
  assert.equal(await (await fetch(`${server.url}/feishu/webhook`, { method: "POST", body: "one" })).text(), "old");

  await server.hotStartChannel(nextFeishu);
  assert.equal(await (await fetch(`${server.url}/feishu/webhook`, { method: "POST", body: "two" })).text(), "next");

  await server.reconcileChannels({ channels: [], managedChannelKeys: ["feishu"] });
  assert.equal((await fetch(`${server.url}/feishu/webhook`, { method: "POST", body: "three" })).status, 404);
  assert.deepEqual(events, ["old:one", "next:two"]);
});

test("initial Feishu webhook remains available while its background start is pending", async (t) => {
  const initial = createChannel("feishu", { stuckStart: true });
  const feishu = Object.assign(initial.channel, {
    async handleWebhook(_request: unknown, response: { end(value: string): void }, body: string) {
      response.end(`initial:${body}`);
      return true;
    },
  }) as FeishuChannel;
  const server = await withServer(t, { feishu });

  const response = await fetch(`${server.url}/feishu/webhook`, { method: "POST", body: "ready" });
  assert.equal(await response.text(), "initial:ready");
  assert.equal(initial.starts, 1);
});

test("server close stops active adapters and cleans a late startup without blocking shutdown", async (t) => {
  const server = await withServer(t);
  const active = createChannel("telegram");
  let resolveLateHandle!: (handle: { stop(reason?: string): Promise<void> }) => void;
  const lateStops: string[] = [];
  let lateStartEntered!: () => void;
  const lateStart = new Promise<void>((resolve) => { lateStartEntered = resolve; });
  const late: ChannelAdapter = {
    channelKey: "discord",
    async start() {
      lateStartEntered();
      return new Promise((resolve) => { resolveLateHandle = resolve; });
    },
  };

  await server.hotStartChannel(active.channel);
  const pendingStart = server.hotStartChannel(late);
  await lateStart;
  const firstClose = server.close();
  const secondClose = server.close();
  assert.equal(firstClose, secondClose);
  await firstClose;
  assert.deepEqual(active.stops, ["server-shutdown"]);
  await assert.rejects(server.hotStartChannel(createChannel("telegram").channel), /channel server is closing/);

  resolveLateHandle({
    async stop(reason) {
      lateStops.push(reason ?? "");
    },
  });
  await assert.rejects(pendingStart, /channel server is closing/);
  assert.deepEqual(lateStops, ["server-shutdown"]);
});
