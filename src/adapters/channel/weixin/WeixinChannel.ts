import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ILinkClient, loginWithQR, MessageItemType } from "weixin-ilink";
import type { ClientOptions, GetUpdatesResp, WeixinMessage, LoginResult } from "weixin-ilink";
import type { CronResultDelivery } from "../../../cron/index.js";
import type { Gateway, GatewayChannelKey } from "../../../gateway/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelLogger, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import { executeChannelCommand } from "../protocol/ChannelCommandRegistry.js";
import { deliverChatCronResult } from "../protocol/ImCronDelivery.js";
import { ImElicitationHelper } from "../protocol/ImElicitationHelper.js";
import { ImPermissionHelper } from "../protocol/ImPermissionHelper.js";
import {
  ImLiveReplyController,
  type ImLiveReplyControllerOptions,
  type ImLiveReplyTransport,
} from "../protocol/ImLiveReplyController.js";
import { WeixinSessionMapper } from "./WeixinSessionMapper.js";

const CREDENTIALS_PATH = join(homedir(), ".pilotdeck", "weixin-credentials.json");
const POLL_RETRY_DELAY_MS = 3000;
const WEIXIN_ACTIVITY_DELAY_MS = 10 * 60 * 1000;
const WEIXIN_ACTIVITY_UPDATE_THROTTLE_MS = 10 * 60 * 1000;
const WEIXIN_DEFAULT_TURN_TIMEOUT_MS = 0;
const WEIXIN_TIMEOUT_FINAL_TEXT = "处理时间已超过上限，任务已停止。你可以调整需求后重新发送。";
const WEIXIN_ACTIVITY_TTL_MS = Number.MAX_SAFE_INTEGER;
const WEIXIN_ACTIVITY_MAX_UPDATES = Number.MAX_SAFE_INTEGER;
const WEIXIN_CONNECTION_LOST_TEXT = "微信连接暂时中断，正在尝试恢复。当前任务仍会继续处理，恢复后我会继续回复。";
const WEIXIN_CONNECTION_RECOVERED_TEXT = "微信连接已恢复，我会继续处理当前任务。";
const WEIXIN_CONNECTION_RECOVERED_AFTER_LOSS_TEXT = "微信连接刚刚中断过，现在已恢复。我会继续处理当前任务。";
const WEIXIN_SESSION_EXPIRED_TEXT = "微信登录状态已失效，当前任务无法继续通过微信回复。请重新扫码登录后再试。";
const WEIXIN_MAX_PENDING_REPLIES_PER_CHAT = 20;
let ilinkFetchCompatibilityInstalled = false;

export type WeixinChannelOptions = {
  credentialsPath?: string;
  mapper?: WeixinSessionMapper;
  liveReplyOptions?: Omit<ImLiveReplyControllerOptions<void>, "transport" | "onTransportError">;
  clientFactory?: (options: ClientOptions) => WeixinIlinkClient;
  loginWithQR?: typeof loginWithQR;
};

type SavedCredentials = {
  baseUrl: string;
  botToken: string;
  accountId: string;
  cursor?: string;
};

export type WeixinIlinkClient = {
  cursor: string;
  poll(): Promise<GetUpdatesResp>;
  sendTextChunked(toUserId: string, text: string, contextToken: string, maxLength?: number): Promise<number>;
  sendTyping(userId: string, contextToken?: string): Promise<void>;
};

export class WeixinChannel implements ChannelAdapter {
  readonly channelKey: GatewayChannelKey = "weixin";

  private readonly credentialsPath: string;
  private readonly mapper: WeixinSessionMapper;
  private readonly liveReplyOptions?: WeixinChannelOptions["liveReplyOptions"];
  private readonly clientFactory: (options: ClientOptions) => WeixinIlinkClient;
  private readonly login: typeof loginWithQR;

  private gateway?: Gateway;
  private logger?: ChannelLogger;
  private client?: WeixinIlinkClient;
  private loopAbort = new AbortController();
  private pollPromise: Promise<void> | null = null;
  private activeChats = new Set<string>();
  private activeLiveReplies = new Map<string, ImLiveReplyController<void>>();
  private readonly elicitation = new ImElicitationHelper();
  private readonly permissions = new ImPermissionHelper();
  private contextTokens = new Map<string, string>();
  private consecutivePollErrors = 0;
  private connectionIssueNotified = false;
  private connectionIssueChats = new Set<string>();
  private connectionLostNoticeDeliveredChats = new Set<string>();
  private pendingReplies = new Map<string, string[]>();

  constructor(options: WeixinChannelOptions = {}) {
    this.credentialsPath = options.credentialsPath ?? CREDENTIALS_PATH;
    this.mapper = options.mapper ?? new WeixinSessionMapper();
    this.liveReplyOptions = options.liveReplyOptions;
    this.clientFactory = options.clientFactory ?? ((clientOptions) => new ILinkClient(clientOptions));
    this.login = options.loginWithQR ?? loginWithQR;
  }

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    this.gateway = deps.gateway;
    this.logger = deps.logger;

    const creds = await this.ensureLoggedIn();
    if (!creds) {
      return { stop: async () => undefined };
    }

    installIlinkFetchCompatibility();
    this.client = this.createClient(creds);

    this.loopAbort = new AbortController();
    this.pollPromise = this.pollLoop();
    this.logger?.info?.("weixin: connected, poll loop started");

    return {
      stop: async (reason?: string) => {
        this.logger?.info?.(`weixin: stopping (${reason ?? "no reason"})`);
        this.loopAbort.abort();
        this.saveCursor();
        try { await this.pollPromise; } catch { /* ignore */ }
        this.pollPromise = null;
      },
    };
  }

  async deliverCronResult(delivery: CronResultDelivery): Promise<boolean> {
    return deliverChatCronResult(delivery, this.channelKey, (userId, text) =>
      this.sendReply(userId, text, { queueOnFailure: true }),
    );
  }

  private async ensureLoggedIn(): Promise<SavedCredentials | null> {
    const saved = this.loadCredentials();
    if (saved) {
      this.logger?.info?.(`weixin: loaded saved credentials (account: ${saved.accountId})`);
      return saved;
    }

    this.logger?.info?.("weixin: no credentials found, starting QR login...");
    console.log("\n╔══════════════════════════════════════════════╗");
    console.log("║  微信 iLink 登录 — 请用微信扫描二维码        ║");
    console.log("╚══════════════════════════════════════════════╝\n");

    try {
      const result: LoginResult = await this.login({
        onQRCode: (url) => {
          console.log(`[weixin] 扫码登录链接:\n${url}\n`);
        },
        onStatusChange: (status) => {
          const labels: Record<string, string> = {
            waiting: "等待扫码...",
            scanned: "已扫码，等待确认...",
            expired: "二维码已过期，正在刷新...",
            refreshing: "刷新中...",
          };
          console.log(`[weixin] ${labels[status] ?? status}`);
        },
      });

      const creds: SavedCredentials = {
        baseUrl: result.baseUrl,
        botToken: result.botToken,
        accountId: result.accountId,
      };
      this.saveCredentials(creds);
      console.log(`[weixin] 登录成功! accountId: ${result.accountId}\n`);
      this.logger?.info?.(`weixin: login successful, accountId=${result.accountId}`);
      return creds;
    } catch (e) {
      this.logger?.error?.(`weixin: QR login failed: ${e}`);
      console.error(`[weixin] 登录失败: ${e}`);
      return null;
    }
  }

  private async pollLoop(): Promise<void> {
    if (!this.client) return;

    while (!this.loopAbort.signal.aborted) {
      try {
        const resp = await this.client.poll();
        if (resp.errcode === -14) {
          this.logger?.error?.("weixin: session expired (errcode -14), need re-login");
          console.error("[weixin] Session 过期，请删除凭证文件并重启以重新扫码登录:");
          console.error(`[weixin]   rm ${this.credentialsPath}`);
          await this.notifyActiveChats(WEIXIN_SESSION_EXPIRED_TEXT);
          break;
        }

        if (resp.ret !== 0 && resp.ret !== undefined) {
          this.logger?.warn?.(`weixin: poll ret=${resp.ret} errmsg=${resp.errmsg}`);
          await this.notifyConnectionLost();
          await this.sleep(POLL_RETRY_DELAY_MS);
          continue;
        }

        if (this.consecutivePollErrors > 0) {
          this.logger?.info?.(`weixin: poll recovered after ${this.consecutivePollErrors} error(s)`);
          this.consecutivePollErrors = 0;
        }
        await this.notifyConnectionRecovered();
        await this.flushPendingReplies();

        const messages = resp.msgs ?? [];
        if (messages.length > 0) {
          this.logger?.info?.(`weixin: polled ${messages.length} message(s)`);
        }

        for (const msg of messages) {
          if (msg.message_type === 1) {
            void this.dispatchMessage(msg);
          }
        }

        this.saveCursor();
      } catch (e) {
        if (this.loopAbort.signal.aborted) break;
        this.consecutivePollErrors++;
        this.logger?.error?.(
          `weixin: poll error #${this.consecutivePollErrors}: ${formatWeixinError(e)}`,
        );
        await this.notifyConnectionLost();
        this.rebuildClientAfterPollError(e);
        await this.sleep(POLL_RETRY_DELAY_MS);
      }
    }
  }

  private async dispatchMessage(msg: WeixinMessage): Promise<void> {
    const fromUser = msg.from_user_id ?? "";
    if (!fromUser) return;

    if (msg.context_token) {
      this.contextTokens.set(fromUser, msg.context_token);
    }

    const textItem = msg.item_list?.find((i) => i.type === MessageItemType.TEXT);
    const text = textItem?.text_item?.text ?? "";

    if (!text.trim()) return;
    this.logger?.info?.(`weixin: received text message from ${fromUser}`);

    if (this.elicitation.hasPending(fromUser) && this.gateway) {
      try {
        const confirmation = await this.elicitation.answer(fromUser, text, this.gateway);
        if (confirmation) await this.sendReply(fromUser, confirmation);
      } catch (e) {
        this.logger?.error?.(`weixin: elicitation answer error: ${e}`);
      }
      return;
    }

    if (this.permissions.hasPending(fromUser) && this.gateway) {
      try {
        const trimmed = text.trim();
        const confirmation = await this.permissions.answer(fromUser, text, this.gateway);
        if (confirmation) await this.sendReply(fromUser, confirmation);
        if (trimmed === "1" || trimmed === "2") {
          await this.activeLiveReplies.get(fromUser)?.resumeActivity("tool", { immediate: false });
        }
      } catch (e) {
        this.logger?.error?.(`weixin: permission answer error: ${e}`);
      }
      return;
    }

    const mapped = this.mapper.resolve({ chatId: fromUser, text });
    if (mapped.command === "new" && !mapped.message) {
      await this.sendReply(fromUser, "已创建新会话。");
      return;
    }

    if (this.gateway && text.trim().startsWith("/")) {
      const handled = await executeChannelCommand(text, {
        gateway: this.gateway,
        chatId: fromUser,
        channelKey: "weixin",
        reply: async (msg) => {
          await this.sendReply(fromUser, msg);
        },
        bindProject: (projectKey) => this.mapper.bindProject(fromUser, projectKey),
        getProject: () => this.mapper.getProject(fromUser),
        logger: this.logger as any,
      });
      if (handled) return;
    }

    if (!mapped.message) return;

    if (this.activeChats.has(fromUser)) {
      this.logger?.info?.(`weixin: chat ${fromUser} already active, skipping`);
      return;
    }

    this.activeChats.add(fromUser);
    try {
      await this.processMessage(fromUser, mapped.sessionKey, mapped.message, mapped.projectKey);
    } finally {
      this.activeChats.delete(fromUser);
    }
  }

  private async processMessage(
    userId: string,
    sessionKey: string,
    message: string,
    projectKey?: string,
  ): Promise<void> {
    if (!this.gateway) return;

    const turnTimeoutMs = this.liveReplyOptions?.turnTimeoutMs ?? WEIXIN_DEFAULT_TURN_TIMEOUT_MS;
    const liveReply = new ImLiveReplyController<void>({
      ...this.liveReplyOptions,
      turnTimeoutMs,
      activityDelayMs: this.liveReplyOptions?.activityDelayMs ?? WEIXIN_ACTIVITY_DELAY_MS,
      activityUpdateThrottleMs:
        this.liveReplyOptions?.activityUpdateThrottleMs ?? WEIXIN_ACTIVITY_UPDATE_THROTTLE_MS,
      activityMaxUpdates: this.liveReplyOptions?.activityMaxUpdates ?? WEIXIN_ACTIVITY_MAX_UPDATES,
      activityTtlMs: this.liveReplyOptions?.activityTtlMs ?? WEIXIN_ACTIVITY_TTL_MS,
      formatActivity: this.liveReplyOptions?.formatActivity ?? formatWeixinActivity,
      timeoutFinalText: this.liveReplyOptions?.timeoutFinalText ?? WEIXIN_TIMEOUT_FINAL_TEXT,
      transport: this.createLiveReplyTransport(userId),
      onTransportError: (error, phase) => {
        this.logger?.warn?.(`weixin: live reply ${phase} failed: ${formatWeixinError(error)}`);
      },
    });
    this.activeLiveReplies.set(userId, liveReply);
    let activeRunId: string | undefined;
    let watchdogSettled = false;
    let timeoutNotice: Promise<void> | undefined;
    const notifyTimedOut = (): Promise<void> => {
      timeoutNotice ??= liveReply.markTimedOut().catch((error: unknown) => {
        this.logger?.warn?.(`weixin: mark timeout failed: ${formatWeixinError(error)}`);
      });
      return timeoutNotice;
    };
    const watchdog = turnTimeoutMs > 0
      ? setTimeout(() => {
          if (watchdogSettled) return;
          watchdogSettled = true;
          this.logger?.warn?.(`weixin: live reply timed out for user ${userId}`);
          void notifyTimedOut()
            .then(() => this.gateway?.abortTurn({ sessionKey, ...(activeRunId ? { runId: activeRunId } : {}) }))
            .catch((error: unknown) => {
              this.logger?.warn?.(`weixin: abort timeout turn failed: ${formatWeixinError(error)}`);
            });
        }, turnTimeoutMs)
      : undefined;
    watchdog?.unref?.();

    try {
      void this.sendTypingIfPossible(userId);
      for await (const event of this.gateway.submitTurn({
        sessionKey,
        channelKey: "weixin",
        message,
        allowPlanModeTools: false,
        ...(turnTimeoutMs > 0 ? { timeoutMs: turnTimeoutMs } : {}),
        ...(projectKey ? { projectKey } : {}),
      })) {
        if (event.type === "turn_started") {
          activeRunId = event.runId;
        }
        if (event.type === "elicitation_request") {
          const questionText = this.elicitation.capture(userId, sessionKey, event);
          await liveReply.pauseActivity();
          await this.sendReply(userId, questionText);
          continue;
        }
        if (event.type === "permission_request") {
          const questionText = this.permissions.capture(userId, sessionKey, event);
          await liveReply.pauseActivity();
          await this.sendReply(userId, questionText);
          continue;
        }
        if (event.type === "error" && event.code === "agent_aborted") {
          if (timeoutNotice) {
            await timeoutNotice;
            continue;
          }
          await liveReply.markAborted();
          continue;
        }
        if (event.type === "error" && event.code === "turn_timeout") {
          watchdogSettled = true;
          await notifyTimedOut();
          continue;
        }
        await liveReply.handleEvent(event);
      }
    } catch (e) {
      this.logger?.error?.(`weixin: submitTurn error: ${formatWeixinError(e)}`);
      await liveReply.handleEvent({
        type: "error",
        message: "处理消息时发生错误，请重试。",
        recoverable: true,
      });
    } finally {
      watchdogSettled = true;
      if (watchdog) clearTimeout(watchdog);
      await timeoutNotice;
      this.activeLiveReplies.delete(userId);
    }

    this.elicitation.clear(userId);
    this.permissions.clear(userId);
    await liveReply.flushFinal();
  }

  private createLiveReplyTransport(userId: string): ImLiveReplyTransport<void> {
    return {
      send: async (text) => {
        await this.sendReply(userId, text, { queueOnFailure: true });
        return undefined;
      },
      pulseActivity: async (activity) => {
        await this.sendReply(userId, activity.text);
        await this.sendTypingIfPossible(userId);
        return true;
      },
      stopActivity: async () => true,
    };
  }

  private async sendReply(userId: string, text: string, options: { queueOnFailure?: boolean } = {}): Promise<boolean> {
    if (!this.client) {
      if (options.queueOnFailure) this.queuePendingReply(userId, text);
      return false;
    }
    const contextToken = this.contextTokens.get(userId);
    if (!contextToken) {
      this.logger?.warn?.(`weixin: no context_token for ${userId}, cannot send`);
      if (options.queueOnFailure) this.queuePendingReply(userId, text);
      return false;
    }
    try {
      await this.client.sendTextChunked(userId, text, contextToken, 2000);
      this.logger?.info?.(`weixin: sent reply to ${userId}`);
      return true;
    } catch (e) {
      this.logger?.error?.(`weixin: sendText failed: ${formatWeixinError(e)}`);
      if (options.queueOnFailure) this.queuePendingReply(userId, text);
      return false;
    }
  }

  private async sendTypingIfPossible(userId: string): Promise<void> {
    if (!this.client) return;
    const contextToken = this.contextTokens.get(userId);
    if (!contextToken) return;
    try {
      await this.client.sendTyping(userId, contextToken);
    } catch (e) {
      this.logger?.warn?.(`weixin: sendTyping failed: ${formatWeixinError(e)}`);
    }
  }

  private async notifyConnectionLost(): Promise<void> {
    if (this.connectionIssueNotified) return;
    this.connectionIssueNotified = true;
    this.connectionIssueChats = new Set(this.activeChats);
    this.connectionLostNoticeDeliveredChats = await this.notifyActiveChats(WEIXIN_CONNECTION_LOST_TEXT);
  }

  private async notifyConnectionRecovered(): Promise<void> {
    if (!this.connectionIssueNotified) return;
    this.connectionIssueNotified = false;
    const chatsToNotify = new Set([...this.connectionIssueChats, ...this.activeChats]);
    await Promise.all([...chatsToNotify].map((userId) => {
      const text = this.connectionLostNoticeDeliveredChats.has(userId)
        ? WEIXIN_CONNECTION_RECOVERED_TEXT
        : WEIXIN_CONNECTION_RECOVERED_AFTER_LOSS_TEXT;
      return this.sendReply(userId, text);
    }));
    this.connectionIssueChats.clear();
    this.connectionLostNoticeDeliveredChats.clear();
  }

  private async notifyActiveChats(text: string): Promise<Set<string>> {
    const delivered = new Set<string>();
    if (this.activeChats.size === 0) return delivered;
    const results = await Promise.all(
      [...this.activeChats].map(async (userId) => ({
        userId,
        ok: await this.sendReply(userId, text),
      })),
    );
    for (const result of results) {
      if (result.ok) delivered.add(result.userId);
    }
    return delivered;
  }

  private queuePendingReply(userId: string, text: string): void {
    const pending = this.pendingReplies.get(userId) ?? [];
    pending.push(text);
    if (pending.length > WEIXIN_MAX_PENDING_REPLIES_PER_CHAT) {
      pending.splice(0, pending.length - WEIXIN_MAX_PENDING_REPLIES_PER_CHAT);
    }
    this.pendingReplies.set(userId, pending);
  }

  private async flushPendingReplies(): Promise<void> {
    if (this.pendingReplies.size === 0) return;
    for (const [userId, replies] of [...this.pendingReplies]) {
      while (replies.length > 0) {
        const text = replies[0];
        if (!(await this.sendReply(userId, text))) break;
        replies.shift();
      }
      if (replies.length === 0) {
        this.pendingReplies.delete(userId);
      }
    }
  }

  private createClient(creds: SavedCredentials, cursor = creds.cursor): WeixinIlinkClient {
    const client = this.clientFactory({
      baseUrl: creds.baseUrl,
      token: creds.botToken,
    });
    if (cursor) {
      client.cursor = cursor;
    }
    return client;
  }

  private rebuildClientAfterPollError(error: unknown): void {
    if (!isRecoverablePollError(error)) return;
    const creds = this.loadCredentials();
    if (!creds) {
      this.logger?.warn?.("weixin: cannot rebuild iLink client because credentials are missing");
      return;
    }

    const cursor = this.client?.cursor || creds.cursor;
    this.client = this.createClient(creds, cursor);
    if (cursor && creds.cursor !== cursor) {
      creds.cursor = cursor;
      this.saveCredentials(creds);
    }
    this.logger?.warn?.("weixin: rebuilt iLink client after recoverable poll error");
  }

  private loadCredentials(): SavedCredentials | null {
    try {
      if (!existsSync(this.credentialsPath)) return null;
      const raw = readFileSync(this.credentialsPath, "utf-8");
      const data = JSON.parse(raw) as Partial<SavedCredentials>;
      if (!data.baseUrl || !data.botToken || !data.accountId) return null;
      return data as SavedCredentials;
    } catch {
      return null;
    }
  }

  private saveCredentials(creds: SavedCredentials): void {
    try {
      const dir = join(homedir(), ".pilotdeck");
      mkdirSync(dir, { recursive: true });
      writeFileSync(this.credentialsPath, JSON.stringify(creds, null, 2), "utf-8");
    } catch (e) {
      this.logger?.error?.(`weixin: failed to save credentials: ${e}`);
    }
  }

  private saveCursor(): void {
    if (!this.client) return;
    const creds = this.loadCredentials();
    if (creds) {
      creds.cursor = this.client.cursor;
      this.saveCredentials(creds);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.loopAbort.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}

function isRecoverablePollError(error: unknown): boolean {
  const detail = formatWeixinError(error).toLowerCase();
  return (
    detail.includes("fetch failed") ||
    detail.includes("econnreset") ||
    detail.includes("enet") ||
    detail.includes("etimedout") ||
    detail.includes("und_err") ||
    detail.includes("socket") ||
    detail.includes("network") ||
    detail.includes("timeout")
  );
}

function formatWeixinError(error: unknown, depth = 0): string {
  if (error instanceof Error) {
    const pieces = [`${error.name}: ${error.message}`];
    const code = readStringProperty(error, "code");
    if (code) pieces.push(`code=${code}`);
    const cause = (error as { cause?: unknown }).cause;
    if (cause && depth < 2) {
      pieces.push(`cause=(${formatWeixinError(cause, depth + 1)})`);
    }
    if (depth === 0) {
      const stackLine = error.stack?.split("\n").slice(1, 2).map((line) => line.trim()).find(Boolean);
      if (stackLine) pieces.push(`at=${stackLine}`);
    }
    return pieces.join("; ");
  }

  if (typeof error === "object" && error !== null) {
    const name = readStringProperty(error, "name");
    const message = readStringProperty(error, "message");
    const code = readStringProperty(error, "code");
    const pieces = [name, message].filter(Boolean);
    if (code) pieces.push(`code=${code}`);
    if (pieces.length > 0) return pieces.join("; ");
  }

  return String(error);
}

function readStringProperty(source: object, key: string): string | undefined {
  const value = (source as Record<string, unknown>)[key];
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function formatWeixinActivity(activity: { kind: "thinking" | "tool" | "subagent"; elapsedMs: number }): string {
  const elapsed = formatElapsed(activity.elapsedMs);
  const suffix = elapsed ? `（已用时 ${elapsed}）` : "";
  if (activity.kind === "tool") {
    return `仍在处理：正在执行工具${suffix}`;
  }
  if (activity.kind === "subagent") {
    return `仍在处理：正在处理子任务${suffix}`;
  }
  return `仍在处理：正在分析和生成回复${suffix}`;
}

function formatElapsed(elapsedMs: number): string {
  if (elapsedMs < 60_000) {
    return "";
  }
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) {
    return `${minutes} 分钟`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

function installIlinkFetchCompatibility(): void {
  if (ilinkFetchCompatibilityInstalled) return;
  ilinkFetchCompatibilityInstalled = true;

  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" || input instanceof URL
      ? String(input)
      : input.url;
    if (!url.includes("/ilink/bot/") || !init?.headers) {
      return originalFetch(input, init);
    }

    const headers = stripContentLengthHeader(init.headers);
    return originalFetch(input, { ...init, headers });
  }) as typeof fetch;
}

function stripContentLengthHeader(headers: HeadersInit): HeadersInit {
  if (headers instanceof Headers) {
    const next = new Headers(headers);
    next.delete("content-length");
    next.delete("Content-Length");
    return next;
  }

  if (Array.isArray(headers)) {
    return headers.filter(([key]) => key.toLowerCase() !== "content-length");
  }

  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== "content-length") {
      next[key] = value;
    }
  }
  return next;
}
