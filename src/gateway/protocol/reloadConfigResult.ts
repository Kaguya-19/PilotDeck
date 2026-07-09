import type { ReloadConfigResult } from "./types.js";

const RELOAD_CONFIG_REASONS = new Set(["unsupported", "unchanged"]);

export function parseReloadConfigResult(value: unknown): ReloadConfigResult {
  if (!isRecord(value)) {
    throw new Error("Invalid reload_config response: result must be an object.");
  }

  if (typeof value.reloaded !== "boolean") {
    throw new Error("Invalid reload_config response: reloaded must be a boolean.");
  }

  const result: ReloadConfigResult = { reloaded: value.reloaded };

  if (value.changedPaths !== undefined) {
    if (!Array.isArray(value.changedPaths) || value.changedPaths.some((entry) => typeof entry !== "string")) {
      throw new Error("Invalid reload_config response: changedPaths must be an array of strings.");
    }
    result.changedPaths = value.changedPaths;
  }

  if (value.reason !== undefined) {
    if (typeof value.reason !== "string" || !RELOAD_CONFIG_REASONS.has(value.reason)) {
      throw new Error("Invalid reload_config response: reason must be \"unsupported\" or \"unchanged\".");
    }
    result.reason = value.reason as ReloadConfigResult["reason"];
  }

  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
