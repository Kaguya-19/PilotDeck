import { loadPilotConfig } from "../../pilot/config/loadPilotConfig.js";
import {
  listModelCatalog,
  normalizeSessionModelSelection,
  restoreSessionModelSelection,
  validateExplicitModelSelection,
  validateModelSelection,
} from "../../gateway/dialog/modelCatalog.js";
import type {
  ExplicitModelSelection,
  ModelCatalogListInput,
  ModelCatalogListResult,
  SessionModelSelection,
} from "../../gateway/protocol/types.js";
import type { SessionModelSelectionPolicy } from "./SessionModelSelectionPort.js";

/** Native catalog/config policy provider for session model selection. */
export class NativeSessionModelSelectionPolicy implements SessionModelSelectionPolicy {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  listCatalog(input: ModelCatalogListInput): ModelCatalogListResult {
    return listModelCatalog(input, this.env);
  }

  normalizeSelection(selection: SessionModelSelection): SessionModelSelection {
    return normalizeSessionModelSelection(selection);
  }

  restoreSelection(projectKey: string, selection: SessionModelSelection): SessionModelSelection {
    return restoreSessionModelSelection(projectKey, selection, this.env);
  }

  validateSelection(projectKey: string, selection: SessionModelSelection): void {
    validateModelSelection(projectKey, selection, this.env);
  }

  validateExplicit(projectKey: string, selection: ExplicitModelSelection): void {
    validateExplicitModelSelection(projectKey, selection, this.env);
  }

  resolveDefault(projectKey: string): {
    provider: string;
    model: string;
    source: "router" | "default";
  } {
    const config = loadPilotConfig({ projectRoot: projectKey, env: this.env }).config;
    return {
      provider: config.agent.model.provider,
      model: config.agent.model.model,
      source: config.router?.enabled ? "router" : "default",
    };
  }
}
