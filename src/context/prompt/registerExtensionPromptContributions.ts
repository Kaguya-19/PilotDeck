import type { ExtensionResolver } from "../extension/ExtensionResolver.js";
import {
  PromptContributionRegistry,
  type PromptContributionRegistration,
} from "./PromptContributionRegistry.js";

/**
 * Context composition adapter for extension-owned prompt sections.
 *
 * ExtensionRuntime supplies a frozen, read-only contribution snapshot. This
 * adapter creates registrations in the session-owned registry, so the agent
 * scope—not the extension runtime—owns their lifetime and a plugin refresh
 * cannot alter a prompt that is already being assembled.
 */
export function registerExtensionPromptContributions(
  registry: PromptContributionRegistry,
  extension: Pick<ExtensionResolver, "listPromptContributions">,
): PromptContributionRegistration[] {
  const contributions = extension.listPromptContributions?.() ?? [];
  return contributions
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((contribution) => registry.registerSection({
      name: contribution.name,
      // Plugin sections deliberately follow native identity/instruction
      // sections while retaining deterministic ordering among themselves.
      order: 10_000,
      text: contribution.content,
    }));
}
