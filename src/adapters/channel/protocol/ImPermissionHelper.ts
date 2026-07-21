import type { Gateway, GatewayEvent } from "../../../gateway/index.js";

type PendingPermission = {
  sessionKey: string;
  requestId: string;
  toolName: string;
  payload: unknown;
};

export class ImPermissionHelper {
  private readonly pending = new Map<string, PendingPermission[]>();

  capture(chatId: string, sessionKey: string, event: GatewayEvent & { type: "permission_request" }): string | undefined {
    const entries = this.pending.get(chatId) ?? [];
    entries.push({
      sessionKey,
      requestId: event.requestId,
      toolName: event.toolName,
      payload: event.payload,
    });
    this.pending.set(chatId, entries);

    return formatPermissionPrompt(entries);
  }

  hasPending(chatId: string): boolean {
    return (this.pending.get(chatId)?.length ?? 0) > 0;
  }

  async answer(chatId: string, text: string, gateway: Gateway): Promise<string | undefined> {
    const entries = this.pending.get(chatId);
    if (!entries || entries.length === 0) return undefined;

    const trimmed = text.trim();
    if (trimmed !== "0" && trimmed !== "1" && trimmed !== "2") {
      return "请回复 1 允许一次，回复 2 允许本会话，回复 0 拒绝。";
    }

    this.pending.delete(chatId);
    const deny = trimmed === "0";
    for (const entry of entries) {
      await gateway.permissionDecide({
        sessionKey: entry.sessionKey,
        requestId: entry.requestId,
        decision: deny ? "deny" : "allow",
        ...(deny ? { reason: "User denied permission from IM channel." } : {}),
        ...(!deny ? { remember: trimmed === "2" } : {}),
      });
    }
    const count = entries.length;
    if (trimmed === "0") {
      return count === 1 ? "已拒绝，继续处理。" : `已拒绝 ${count} 个待处理权限请求，继续处理。`;
    }

    if (trimmed === "2") {
      return count === 1 ? "已允许本会话，继续执行。" : `已允许本会话的 ${count} 个待处理权限请求，继续执行。`;
    }
    return count === 1 ? "已允许一次，继续执行。" : `已允许 ${count} 个待处理权限请求一次，继续执行。`;
  }

  clear(chatId: string): void {
    this.pending.delete(chatId);
  }
}

function formatPayload(payload: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(payload, null, 2) ?? String(payload);
  } catch {
    text = String(payload);
  }

  const trimmed = text.trim();
  if (trimmed.length <= 800) return trimmed || "(空)";
  return `${trimmed.slice(0, 800)}...`;
}

function formatPermissionPrompt(entries: PendingPermission[]): string {
  if (entries.length === 1) {
    const entry = entries[0]!;
    return [
      `工具 ${entry.toolName} 需要权限才能继续执行。`,
      "",
      "请求内容：",
      formatPayload(entry.payload),
      "",
      "回复 1 允许一次，回复 2 允许本会话，回复 0 拒绝。",
    ].join("\n");
  }

  const lines = [
    `共有 ${entries.length} 个工具权限请求正在等待，以下请求都会被本次回复处理：`,
  ];

  entries.forEach((entry, index) => {
    lines.push(
      "",
      `请求 ${index + 1}: 工具 ${entry.toolName}`,
      "请求内容：",
      formatPayload(entry.payload),
    );
  });

  lines.push("", "回复 1 允许以上所有待处理请求一次，回复 2 允许本会话，回复 0 拒绝。");
  return lines.join("\n");
}
