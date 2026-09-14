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
    const projectKey = await this.options.resolveProjectKey(input.projectKey);
    return this.options.policy.listCatalog({ ...input, projectKey });
  }

  async sessionModelGet(input: SessionModelInput): Promise<SessionModelResult> {
    const projectKey = await this.options.resolveProjectKey(input.projectKey);
    return this.result(
      projectKey,
      input.sessionKey,
      await this.options.selectionPort.read({ projectKey, sessionKey: input.sessionKey }),
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
    await this.options.selectionPort.write({
      projectKey,
      sessionKey: input.sessionKey,
      selection: input.selection,
    });
    await this.options.router.close(input.sessionKey);
    return this.result(projectKey, input.sessionKey, input.selection);
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
    input: Pick<GatewaySubmitTurnInput, "projectKey" | "sessionKey" | "modelOverride">,
  ): Promise<{
    selection?: NonNullable<GatewaySubmitTurnInput["modelOverride"]>;
    source: "turn" | "session" | "router" | "default";
  }> {
    const projectKey = await this.options.resolveProjectKey(input.projectKey ?? this.options.fallbackProjectKey);
    if (input.modelOverride) {
      this.options.policy.validateExplicit(projectKey, input.modelOverride);
      return { selection: input.modelOverride, source: "turn" };
    }
    const saved = await this.options.selectionPort.read({ projectKey, sessionKey: input.sessionKey });
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
            temperature: explicit.temperature,
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
