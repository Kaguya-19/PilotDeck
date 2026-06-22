import type { PermissionMode, PermissionRule } from "../../permission/index.js";

/**
 * Tools that require a live user response and therefore cannot be exposed
 * to unattended agent sessions such as Always-On and Cron.
 */
export const UNATTENDED_SESSION_EXCLUDED_TOOLS = [
  "enter_plan_mode",
  "exit_plan_mode",
  "ask_user_question",
] as const;

export type SessionConfigOverride = {
  cwd?: string;
  permissionMode?: PermissionMode;
  bypassAvailable?: boolean;
  canPrompt?: boolean;
  /**
   * Per-session permission rules — merged into the
   * `PermissionContext.rules` produced by `createDefaultPermissionContext`.
   * Used by Web UI bridges to translate "Permission added" (the user
   * approving a tool from a chat banner) into a real allow rule, instead
   * of flipping the whole session into bypassPermissions.
   */
  permissionRules?: {
    allow?: PermissionRule[];
    deny?: PermissionRule[];
    ask?: PermissionRule[];
  };
  /**
   * Tool names to exclude from the session's tool registry. Used by
   * unattended runtimes to remove interactive/blocking tools that cannot
   * function without a human respondent.
   */
  excludeTools?: string[];
};

/**
 * Keyed by `sessionKey`, this registry lets unattended runtimes override the
 * `cwd`, permission mode, and tool set of AgentSessions created by
 * `ProjectRuntimeRegistry`. Entries must be installed before the first turn
 * creates the session.
 *
 * The registry is intentionally minimal — it does not own AgentSessions, only
 * the per-session inputs that the factory needs at creation time.
 */
export class SessionConfigOverrides {
  private readonly map = new Map<string, SessionConfigOverride>();

  set(sessionKey: string, override: SessionConfigOverride): void {
    this.map.set(sessionKey, { ...override });
  }

  get(sessionKey: string): SessionConfigOverride | undefined {
    const entry = this.map.get(sessionKey);
    return entry ? { ...entry } : undefined;
  }

  delete(sessionKey: string): void {
    this.map.delete(sessionKey);
  }

  deletePrefix(prefix: string): void {
    for (const sessionKey of this.map.keys()) {
      if (sessionKey.startsWith(prefix)) {
        this.map.delete(sessionKey);
      }
    }
  }

  clear(): void {
    this.map.clear();
  }
}
