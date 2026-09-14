import type { ExtensionResolver } from "../../context/extension/ExtensionResolver.js";
import type { PilotDeckToolAvailability, PilotDeckToolAvailabilityContext, PilotDeckToolDefinition } from "../protocol/types.js";
import {
  ToolRegistry,
  type ToolRegistration,
  type ToolUnavailableDiagnostic,
} from "./ToolRegistry.js";

/**
 * Registers one frozen extension generation in a session-owned registry.
 *
 * ToolRegistry remains the sole model-schema source. This adapter only adds
 * selected definitions to that registry and returns its exact registration
 * handles, so a failed contribution set can be rolled back without mutating
 * the project registry or another Agent scope.
 */
export function registerExtensionToolContributions(
  registry: ToolRegistry,
  extension: Pick<ExtensionResolver, "listToolContributions">,
): ToolRegistration[] {
  const contributions = extension.listToolContributions?.() ?? [];
  const ordered = contributions
    .slice()
    .sort((left, right) => left.tool.name.localeCompare(right.tool.name) || (left.namespace ?? "").localeCompare(right.namespace ?? ""));
  const registrations: ToolRegistration[] = [];
  try {
    for (const contribution of ordered) {
      const name = contribution.tool.name;
      if (registry.has(name) || registry.getUnavailable(name)) {
        throw new Error(
          `Extension tool "${name}" from ${contribution.namespace ?? "an unnamed extension"} conflicts with an existing tool or unavailable capability.`,
        );
      }
      registrations.push(registry.register(contribution.tool));
    }
    return registrations;
  } catch (error) {
    for (const registration of registrations.reverse()) registration.dispose();
    throw error;
  }
}

export type AvailableExtensionToolContributions = {
  registrations: ToolRegistration[];
  unavailable: ToolUnavailableDiagnostic[];
};

/**
 * Preflight extension tools against the same availability contract used by
 * builtin tools, then register the available definitions in the final
 * session registry. No intermediate registry owns the resulting handles.
 */
export async function registerAvailableExtensionToolContributions(
  registry: ToolRegistry,
  extension: Pick<ExtensionResolver, "listToolContributions">,
  context: PilotDeckToolAvailabilityContext,
): Promise<AvailableExtensionToolContributions> {
  const contributions = orderedContributions(extension);
  preflightContributions(registry, contributions);

  const unavailable: Array<{ diagnostic: ToolUnavailableDiagnostic; aliases: readonly string[] }> = [];
  const available: typeof contributions = [];
  const checks = new Map<NonNullable<PilotDeckToolDefinition["checkAvailability"]>, Promise<PilotDeckToolAvailability>>();
  for (const contribution of contributions) {
    const availability = await resolveAvailability(contribution.tool, context, checks);
    if (availability.ok) {
      available.push(contribution);
    } else {
      unavailable.push({
        diagnostic: {
          toolName: contribution.tool.name,
          code: availability.code,
          reason: availability.reason,
        },
        aliases: contribution.tool.aliases ?? [],
      });
    }
  }

  const registrations: ToolRegistration[] = [];
  try {
    for (const contribution of available) registrations.push(registry.register(contribution.tool));
  } catch (error) {
    for (const registration of registrations.reverse()) registration.dispose();
    throw error;
  }
  for (const entry of unavailable) registry.markUnavailable(entry.diagnostic, entry.aliases);
  return { registrations, unavailable: unavailable.map((entry) => entry.diagnostic) };
}

function orderedContributions(extension: Pick<ExtensionResolver, "listToolContributions">) {
  return (extension.listToolContributions?.() ?? [])
    .slice()
    .sort((left, right) => left.tool.name.localeCompare(right.tool.name) || (left.namespace ?? "").localeCompare(right.namespace ?? ""));
}

function preflightContributions(
  registry: ToolRegistry,
  contributions: ReturnType<typeof orderedContributions>,
): void {
  const staged = new ToolRegistry();
  for (const contribution of contributions) {
    const names = [contribution.tool.name, ...(contribution.tool.aliases ?? [])];
    for (const name of names) {
      if (registry.has(name) || registry.getUnavailable(name)) {
        throw new Error(
          `Extension tool "${name}" from ${contribution.namespace ?? "an unnamed extension"} conflicts with an existing tool or unavailable capability.`,
        );
      }
    }
    // Validate collisions among the frozen extension generation before any
    // real session registration is mutated.
    staged.register(contribution.tool);
  }
}

async function resolveAvailability(
  tool: PilotDeckToolDefinition,
  context: PilotDeckToolAvailabilityContext,
  checks: Map<NonNullable<PilotDeckToolDefinition["checkAvailability"]>, Promise<PilotDeckToolAvailability>>,
): Promise<PilotDeckToolAvailability> {
  if (!tool.checkAvailability) return { ok: true };
  let pending = checks.get(tool.checkAvailability);
  if (!pending) {
    pending = Promise.resolve()
      .then(() => tool.checkAvailability!(context))
      .catch((error): PilotDeckToolAvailability => ({
        ok: false,
        code: "failed_check",
        reason: error instanceof Error ? error.message : String(error),
      }));
    checks.set(tool.checkAvailability, pending);
  }
  return pending;
}
