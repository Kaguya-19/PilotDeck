import test from "node:test";
import assert from "node:assert/strict";

import { ImPermissionHelper } from "../../src/adapters/channel/protocol/ImPermissionHelper.js";
import type { Gateway } from "../../src/gateway/index.js";

test("ImPermissionHelper resolves all pending permission requests for a chat", async () => {
  const helper = new ImPermissionHelper();
  const decisions: Array<{
    sessionKey: string;
    requestId: string;
    decision: string;
    remember?: boolean;
  }> = [];
  const gateway = {
    permissionDecide: async (input: {
      sessionKey: string;
      requestId: string;
      decision: string;
      remember?: boolean;
    }) => {
      decisions.push(input);
      return { delivered: true };
    },
  } as unknown as Gateway;

  const first = helper.capture("chat-1", "session-1", {
    type: "permission_request",
    requestId: "request-1",
    toolName: "read_file",
    payload: { file_path: "/tmp/a.txt" },
  });
  const second = helper.capture("chat-1", "session-1", {
    type: "permission_request",
    requestId: "request-2",
    toolName: "read_file",
    payload: { file_path: "/tmp/b.txt" },
  });

  assert.match(first ?? "", /工具 read_file 需要权限/);
  assert.match(first ?? "", /\/tmp\/a\.txt/);
  assert.match(second ?? "", /2 个工具权限请求|2 个工具权限/);
  assert.match(second ?? "", /请求 1: 工具 read_file/);
  assert.match(second ?? "", /\/tmp\/a\.txt/);
  assert.match(second ?? "", /请求 2: 工具 read_file/);
  assert.match(second ?? "", /\/tmp\/b\.txt/);
  assert.equal(helper.hasPending("chat-1"), true);

  const confirmation = await helper.answer("chat-1", "1", gateway);

  assert.equal(confirmation, "已允许 2 个待处理权限请求一次，继续执行。");
  assert.deepEqual(decisions, [
    { sessionKey: "session-1", requestId: "request-1", decision: "allow", remember: false },
    { sessionKey: "session-1", requestId: "request-2", decision: "allow", remember: false },
  ]);
  assert.equal(helper.hasPending("chat-1"), false);
});

test("ImPermissionHelper keeps pending requests when the reply is invalid", async () => {
  const helper = new ImPermissionHelper();
  const gateway = {
    permissionDecide: async () => ({ delivered: true }),
  } as unknown as Gateway;

  helper.capture("chat-1", "session-1", {
    type: "permission_request",
    requestId: "request-1",
    toolName: "read_file",
    payload: { file_path: "/tmp/a.txt" },
  });

  const confirmation = await helper.answer("chat-1", "maybe", gateway);

  assert.equal(confirmation, "请回复 1 允许一次，回复 2 允许本会话，回复 0 拒绝。");
  assert.equal(helper.hasPending("chat-1"), true);
});
