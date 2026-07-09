import { randomUUID } from "node:crypto";

export type FeishuSessionMapperState = {
  activeByChatId: Record<string, string>;
  projectByChatId: Record<string, string>;
};

export type FeishuResolveResult = {
  sessionKey: string;
  projectKey?: string;
  command?: "new" | "projects" | "switch-project";
  /** For /switch-project: the requested project name. */
  commandArg?: string;
  message: string;
};

export class FeishuSessionMapper {
  constructor(
    private readonly state: FeishuSessionMapperState = { activeByChatId: {}, projectByChatId: {} },
    private readonly uuid: () => string = randomUUID,
  ) {}

  resolve(input: { chatId: string; text: string }): FeishuResolveResult {
    const trimmed = input.text.trim();

    if (trimmed === "/new" || trimmed.startsWith("/new ")) {
      const sessionKey = `feishu:chat=${input.chatId}:s_${this.uuid()}`;
      this.state.activeByChatId[input.chatId] = sessionKey;
      return {
        sessionKey,
        projectKey: this.state.projectByChatId[input.chatId],
        command: "new",
        message: trimmed.slice("/new".length).trim(),
      };
    }

    if (trimmed === "/projects") {
      return {
        sessionKey: this.currentSessionKey(input.chatId),
        projectKey: this.state.projectByChatId[input.chatId],
        command: "projects",
        message: "",
      };
    }

    if (trimmed === "/switch-project" || trimmed.startsWith("/switch-project ")) {
      const arg = trimmed.slice("/switch-project".length).trim();
      return {
        sessionKey: this.currentSessionKey(input.chatId),
        projectKey: this.state.projectByChatId[input.chatId],
        command: "switch-project",
        commandArg: arg || undefined,
        message: "",
      };
    }

    return {
      sessionKey: this.currentSessionKey(input.chatId),
      projectKey: this.state.projectByChatId[input.chatId],
      message: trimmed,
    };
  }

  bindProject(chatId: string, projectKey: string): void {
    this.state.projectByChatId[chatId] = projectKey;
  }

  getProject(chatId: string): string | undefined {
    return this.state.projectByChatId[chatId];
  }

  getSession(chatId: string): string {
    return this.currentSessionKey(chatId);
  }

  private currentSessionKey(chatId: string): string {
    return this.state.activeByChatId[chatId] ?? `feishu:chat=${chatId}:general`;
  }

  snapshot(): FeishuSessionMapperState {
    return {
      activeByChatId: { ...this.state.activeByChatId },
      projectByChatId: { ...this.state.projectByChatId },
    };
  }
}
