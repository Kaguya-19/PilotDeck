import type { PermissionMode } from "../../../permission/index.js";
import type { PilotDeckToolResult } from "../../../tool/index.js";
import type { AgentLoopInput } from "../../loop/AgentLoop.js";
import type { AgentRuntimeConfig } from "../../runtime/AgentRuntimeConfig.js";

/**
 * Host-owned live permission-mode state for an external AgentLoop runner.
 *
 * The sidecar can request a mode transition only by returning a successful
 * host-executed capability result. Keeping the state beside the runner makes
 * later host permission/capability/lifecycle callbacks observe the same mode
 * as the native AgentLoop without granting authority to a wire payload.
 */
export class HostPermissionModeState {
  constructor(private readonly config: AgentRuntimeConfig) {}

  applyTurnInput(input: Pick<AgentLoopInput, "permissionMode" | "basePermissionMode">): void {
    const requestedMode = input.permissionMode;
    if (!requestedMode) return;

    if (requestedMode === "plan" && this.config.permissionMode !== "plan") {
      this.config.permissionModeBeforePlan = input.basePermissionMode ?? this.config.permissionMode;
    }
    this.setMode(requestedMode);
  }

  applyCapabilityResults(results: readonly PilotDeckToolResult[]): void {
    for (const result of results) {
      if (result.type !== "success") continue;
      this.applyRequestedMode(result.data);
    }
  }

  private applyRequestedMode(value: unknown): void {
    const requestedMode = requestedPermissionMode(value);
    if (!requestedMode) return;

    let effectiveMode = requestedMode;
    if (requestedMode === "plan" && this.config.permissionMode !== "plan") {
      this.config.permissionModeBeforePlan = this.config.permissionMode;
    } else if (this.config.permissionMode === "plan" && requestedMode !== "plan") {
      if (this.config.permissionModeBeforePlan) {
        effectiveMode = this.config.permissionModeBeforePlan;
        this.config.permissionModeBeforePlan = undefined;
      }
    }
    this.setMode(effectiveMode);
  }

  private setMode(mode: PermissionMode): void {
    this.config.permissionMode = mode;
    this.config.permissionContext.mode = mode;
  }
}

function requestedPermissionMode(value: unknown): PermissionMode | undefined {
  if (!value || typeof value !== "object") return undefined;
  const requestedMode = (value as Record<string, unknown>).requestedMode;
  return requestedMode === "default" || requestedMode === "plan" || requestedMode === "bypassPermissions"
    ? requestedMode
    : undefined;
}
