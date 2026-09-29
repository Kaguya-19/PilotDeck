import type { PilotDeckLoadedPlugin } from "../../extension/index.js";
import type {
  PluginContributionSnapshot,
  PluginSessionContributionSnapshot,
} from "../../extension/index.js";
import {
  collectPluginPromptContributions,
  collectPluginToolContributions,
} from "../../extension/plugins/runtime/PluginRuntime.js";
import type {
  ContributedCommand,
  ContributedPrompt,
  ContributedSkill,
  ContributedTool,
  ExtensionResolver,
  McpServerInstruction,
} from "./ExtensionResolver.js";

/**
 * Minimal runtime contract; extension owner has agreed to expose
 * `getAllCommands()` / `getAllSkills()` aggregators (review 2026-05). Until
 * those exist, we accept just `snapshot()` and flatMap manually with a TODO
 * marker.
 *
 * `ExtensionSnapshot` (turn-stable contribution view) is the long-term API;
 * this resolver will be migrated to read it once the extension owner ships it.
 */
export type PluginRuntimeLike = {
  snapshot(): PilotDeckLoadedPlugin[];
  snapshotSessionContributions?(): PluginSessionContributionSnapshot;
  snapshotContributions?(): PluginContributionSnapshot;
  /** Optional aggregator preferred when available. */
  getAllCommands?(): ContributedCommand[];
  getAllSkills?(): ContributedSkill[];
  /** Optional aggregator for MCP instructions. Phase 6 leaves this empty. */
  getAllMcpInstructions?(): McpServerInstruction[];
};

/**
 * Wraps a `PluginRuntime` (or compatible) so context can read plugin-derived
 * info without reaching into `PilotDeckLoadedPlugin` directly.
 *
 * Decision §3.2 — read-only resolver, no separate registry. When extension
 * owner ships the `ExtensionSnapshot` API this implementation should switch
 * to consume it (deferred `context-extension-snapshot`).
 */
export class PluginRuntimeExtensionResolver implements ExtensionResolver {
  private readonly contributions: {
    readonly generation: number;
    readonly tools: readonly ContributedTool[];
    readonly commands: readonly ContributedCommand[];
    readonly skills: readonly ContributedSkill[];
    readonly prompts: readonly ContributedPrompt[];
    readonly mcpInstructions: readonly McpServerInstruction[];
  };

  constructor(
    runtime: PluginSessionContributionSnapshot | PluginRuntimeLike | PluginContributionSnapshot,
  ) {
    if (isSessionContributionSnapshot(runtime)) {
      this.contributions = fromSessionContributionSnapshot(runtime);
      return;
    }
    if (isContributionSnapshot(runtime)) {
      this.contributions = fromContributionSnapshot(runtime);
      return;
    }
    const sessionSnapshot = runtime.snapshotSessionContributions?.();
    if (sessionSnapshot) {
      this.contributions = fromSessionContributionSnapshot(sessionSnapshot);
      return;
    }
    const snapshot = runtime.snapshotContributions?.();
    if (snapshot) {
      this.contributions = fromContributionSnapshot(snapshot);
      return;
    }
    const plugins = runtime.snapshot();
    this.contributions = Object.freeze({
      generation: 0,
      tools: Object.freeze(collectPluginToolContributions(plugins).map(cloneToolContribution)),
      commands: Object.freeze((runtime.getAllCommands?.() ?? plugins.flatMap((plugin) => (plugin.commands ?? []).map((command): ContributedCommand => ({
        name: command.name,
        description: typeof command.frontmatter?.description === "string" ? command.frontmatter.description : undefined,
        argumentHint: typeof command.frontmatter?.["argument-hint"] === "string" ? command.frontmatter["argument-hint"] as string : undefined,
        content: command.content,
        namespace: plugin.name,
      }))))),
      skills: Object.freeze((runtime.getAllSkills?.() ?? plugins.flatMap((plugin) => (plugin.skills ?? []).map((skill): ContributedSkill => ({
        name: skill.name,
        description: typeof skill.frontmatter?.description === "string" ? skill.frontmatter.description : undefined,
        path: skill.path,
        namespace: plugin.name,
      }))))),
      prompts: Object.freeze(collectPluginPromptContributions(plugins)),
      mcpInstructions: Object.freeze(runtime.getAllMcpInstructions?.() ?? []),
    });
  }

  get generation(): number {
    return this.contributions.generation;
  }

  listCommands(): ContributedCommand[] {
    return this.contributions.commands.map((command) => ({ ...command }));
  }

  listSkills(): ContributedSkill[] {
    return this.contributions.skills.map((skill) => ({ ...skill }));
  }

  listToolContributions(): ContributedTool[] {
    return this.contributions.tools.map(cloneToolContribution);
  }

  listPromptContributions(): ContributedPrompt[] {
    return this.contributions.prompts.map((prompt) => ({ ...prompt }));
  }

  listMcpInstructions(): McpServerInstruction[] {
    return this.contributions.mcpInstructions.map((entry) => ({ ...entry }));
  }
}

function fromSessionContributionSnapshot(
  snapshot: PluginSessionContributionSnapshot,
): PluginRuntimeExtensionResolver["contributions"] {
  return Object.freeze({
    generation: snapshot.generation,
    tools: Object.freeze(snapshot.tools.map(cloneToolContribution)),
    commands: Object.freeze(snapshot.commands.map((command) => ({ ...command }))),
    skills: Object.freeze(snapshot.skills.map((skill) => ({ ...skill }))),
    prompts: Object.freeze(snapshot.prompts.map((prompt) => ({ ...prompt }))),
    mcpInstructions: Object.freeze(snapshot.mcpInstructions.map((entry) => ({ ...entry }))),
  });
}

function fromContributionSnapshot(
  snapshot: PluginContributionSnapshot,
): PluginRuntimeExtensionResolver["contributions"] {
  return Object.freeze({
    generation: snapshot.generation,
    tools: Object.freeze(snapshot.tools.map(cloneToolContribution)),
    commands: Object.freeze(snapshot.commands.map((command) => ({ ...command }))),
    skills: Object.freeze(snapshot.skills.map((skill) => ({ ...skill }))),
    prompts: Object.freeze(collectPluginPromptContributions(snapshot.plugins)),
    mcpInstructions: Object.freeze(snapshot.mcpInstructions.map((entry) => ({ ...entry }))),
  });
}

function isContributionSnapshot(
  source: PluginRuntimeLike | PluginContributionSnapshot,
): source is PluginContributionSnapshot {
  return "plugins" in source && "tools" in source && "generation" in source;
}

function isSessionContributionSnapshot(
  source: PluginSessionContributionSnapshot | PluginRuntimeLike | PluginContributionSnapshot,
): source is PluginSessionContributionSnapshot {
  return "prompts" in source && "tools" in source && "generation" in source;
}

function cloneToolContribution(contribution: ContributedTool): ContributedTool {
  return {
    ...(contribution.namespace ? { namespace: contribution.namespace } : {}),
    tool: {
      ...contribution.tool,
      ...(contribution.tool.aliases ? { aliases: [...contribution.tool.aliases] } : {}),
      ...(contribution.tool.requiredRuntimeCapabilities
        ? { requiredRuntimeCapabilities: [...contribution.tool.requiredRuntimeCapabilities] }
        : {}),
    },
  };
}
