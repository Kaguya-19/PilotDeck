import { existsSync, readFileSync } from "node:fs";

import { parseDocument } from "yaml";

import type { StaffDeckSopBundle } from "./types.js";

/** Loads a deployment-owned SOP definition bundle before a session starts. */
export function loadStaffDeckSopDefinitions(path: string): StaffDeckSopBundle {
  if (!existsSync(path)) {
    throw new Error(`StaffDeck SOP definitions file does not exist: ${path}`);
  }
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Failed to read StaffDeck SOP definitions at ${path}: ${messageOf(error)}`);
  }

  const document = parseDocument(source, { prettyErrors: false });
  if (document.errors.length > 0) {
    throw new Error(`Invalid StaffDeck SOP YAML at ${path}: ${document.errors.map((error) => error.message).join("; ")}`);
  }
  const parsed = document.toJSON();
  const bundle = normalizeBundle(parsed);
  if (!isRecord(bundle) || !Array.isArray(bundle.sops) || bundle.sops.length === 0) {
    throw new Error(`StaffDeck SOP definitions at ${path} must contain a non-empty sops list.`);
  }
  const sops = bundle.sops.map((item, index) => {
    if (!isRecord(item)) throw new Error(`StaffDeck SOP definition ${index} must be an object.`);
    const id = text(item.id) ?? text(item.skill_id);
    if (!id) throw new Error(`StaffDeck SOP definition ${index} must have an id.`);
    return structuredClone(item);
  });
  const ids = new Set<string>();
  for (const definition of sops) {
    const id = text(definition.id) ?? text(definition.skill_id)!;
    if (ids.has(id)) throw new Error(`StaffDeck SOP definitions contain duplicate id '${id}'.`);
    ids.add(id);
  }
  return Object.freeze({ sops: Object.freeze(sops) });
}

/**
 * The formal page-management API returns one published SOP object, while
 * deployment profiles traditionally point at a `{ sops: [...] }` bundle.
 * Accept both wire shapes so a published response can be selected directly by
 * `modules.sop.definitionsPath` without a runner-specific conversion step.
 */
function normalizeBundle(parsed: unknown): Record<string, unknown> {
  if (Array.isArray(parsed)) return { sops: parsed };
  if (!isRecord(parsed)) return parsed as Record<string, unknown>;
  if (Array.isArray(parsed.sops)) return parsed;

  const skillId = text(parsed.skill_id) ?? text(parsed.id);
  const version = text(parsed.version);
  const content = isRecord(parsed.content) ? parsed.content : undefined;
  if (!skillId || !version || !content) return parsed;

  return {
    sops: [{
      id: skillId,
      skill_id: skillId,
      version,
      ...(text(parsed.name) ? { name: text(parsed.name) } : {}),
      ...(text(parsed.business_domain) ? { business_domain: text(parsed.business_domain) } : {}),
      ...(text(parsed.description) ? { description: text(parsed.description) } : {}),
      content,
    }],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
