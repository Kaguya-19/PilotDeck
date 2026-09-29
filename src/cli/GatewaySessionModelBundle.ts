import { DialogGatewayError } from "../gateway/dialog/errors.js";
import type {
  GatewaySubmitTurnInput,
  ModelCatalogListInput,
  ModelCatalogListResult,
  SessionModelInput,
  SessionModelResult,
  SessionModelSetInput,
} from "../gateway/protocol/types.js";
import type {
  SessionModelSelectionPolicy,
  SessionModelSelectionPort,
} from "../model/session/SessionModelSelectionPort.js";

export type GatewaySessionModelRouter = {
  hasActiveTurn(sessionKey: string): boolean;
  close(sessionKey: string): Promise<void>;
};

export type GatewaySessionModelBundleOptions = {
  fallbackProjectKey: string;
  resolveProjectKey: (projectKey: string) => Promise<string>;
  router: GatewaySessionModelRouter;
  selectionPort: SessionModelSelectionPort;
  policy: SessionModelSelectionPolicy;
};

/**
 * Composes Gateway's model-selection RPC consumer over the existing model
 * catalog policy, transcript-backed session preference port, and Router fence.
 * It owns no session state or runtime lifecycle.
 */
export class GatewaySessionModelBundle {
  constructor(private readonly options: GatewaySessionModelBundleOptions) {}

  async modelCatalogList(input: ModelCatalogListInput): Promise<ModelCatalogListResult> {
    return this.options.policy.listCatalog(input);
  }

  async sessionModelGet(input: SessionModelInput): Promise<SessionModelResult> {
    const projectKey = await this.options.resolveProjectKey(input.projectKey);
    const saved = await this.options.selectionPort.read({ projectKey, sessionKey: input.sessionKey });
    return this.result(
      projectKey,
      input.sessionKey,
      saved ? this.options.policy.restoreSelection(projectKey, saved) : undefined,
    );
  }

  async sessionModelSet(input: SessionModelSetInput): Promise<SessionModelResult> {
    const projectKey = await this.options.resolveProjectKey(input.projectKey);
    if (this.options.router.hasActiveTurn(input.sessionKey)) {
      throw new DialogGatewayError("SESSION_BUSY", "Cannot change the model during an active turn.");
    }
    if (!input.selection || typeof input.selection !== "object") {
      throw new DialogGatewayError("INVALID_MODEL_OVERRIDE", "selection is required.");
    }
    this.options.policy.validateSelection(projectKey, input.selection);
    const selection = this.options.policy.normalizeSelection(input.selection);
    await this.options.selectionPort.write({
      projectKey,
      sessionKey: input.sessionKey,
      selection,
    });
    await this.options.router.close(input.sessionKey);
    return this.result(projectKey, input.sessionKey, selection);
  }

  async sessionModelClear(input: SessionModelInput): Promise<void> {
    const projectKey = await this.options.resolveProjectKey(input.projectKey);
    this.requireSessionKey(input.sessionKey);
    if (this.options.router.hasActiveTurn(input.sessionKey)) {
      throw new DialogGatewayError("SESSION_BUSY", "Cannot clear the model during an active turn.");
    }
    await this.options.selectionPort.clear({ projectKey, sessionKey: input.sessionKey });
    await this.options.router.close(input.sessionKey);
  }

  async resolveTurnModelSelection(
    input: Pick<GatewaySubmitTurnInput, "projectKey" | "sessionKey" | "modelSelection" | "modelOverride">,
  ): Promise<{
    selection?: NonNullable<GatewaySubmitTurnInput["modelOverride"]>;
    source: "turn" | "session" | "router" | "default";
  }> {
    const projectKey = await this.options.resolveProjectKey(input.projectKey ?? this.options.fallbackProjectKey);
    if (input.modelSelection !== undefined && input.modelOverride !== undefined) {
      throw new DialogGatewayError(
        "INVALID_MODEL_OVERRIDE",
        "Specify modelSelection or modelOverride, not both.",
      );
    }
    if (input.modelSelection !== undefined) {
      if (!input.modelSelection || typeof input.modelSelection !== "object") {
        throw new DialogGatewayError("INVALID_MODEL_OVERRIDE", "modelSelection must be an object.");
      }
      this.options.policy.validateSelection(projectKey, input.modelSelection);
      const selection = this.options.policy.normalizeSelection(input.modelSelection);
      return selection.mode === "model"
        ? { selection, source: "turn" }
        : { source: "router" };
    }
    if (input.modelOverride) {
      this.options.policy.validateExplicit(projectKey, input.modelOverride);
      return {
        selection: this.options.policy.normalizeSelection(input.modelOverride) as NonNullable<GatewaySubmitTurnInput["modelOverride"]>,
        source: "turn",
      };
    }
    const stored = await this.options.selectionPort.read({ projectKey, sessionKey: input.sessionKey });
    const saved = stored ? this.options.policy.restoreSelection(projectKey, stored) : undefined;
    if (saved?.mode === "model") {
      this.options.policy.validateExplicit(projectKey, saved);
      return { selection: saved, source: "session" };
    }
    return { source: this.options.policy.resolveDefault(projectKey).source };
  }

  private result(
    projectKey: string,
    sessionKey: string,
    saved: Awaited<ReturnType<SessionModelSelectionPort["read"]>>,
  ): SessionModelResult {
    const explicit = saved?.mode === "model" ? saved : undefined;
    const fallback = explicit ? undefined : this.options.policy.resolveDefault(projectKey);
    return {
      projectKey,
      sessionKey,
      ...(saved ? { saved } : {}),
      effective: explicit
        ? {
            provider: explicit.provider,
            model: explicit.model,
            source: "session",
            reasoning: explicit.reasoning,
            speed: explicit.speed,
          }
        : {
            provider: fallback!.provider,
            model: fallback!.model,
            source: fallback!.source,
          },
    };
  }

  private requireSessionKey(sessionKey: string): void {
    if (!sessionKey?.trim()) {
      throw new DialogGatewayError("INVALID_SESSION_KEY", "sessionKey is required.");
    }
  }
}
