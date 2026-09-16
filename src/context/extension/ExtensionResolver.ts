/**
 * Lightweight context-side projection of plugin-derived information.
 *
 * Phase 6 wires the real implementation against `extension/PluginRuntime`,
 * but Phase 2 already declares the interface so PromptAssembler can consume
 * it via dependency injection. Until Phase 6 lands, callers pass
 * `NullExtensionResolver`, which returns empty arrays.
 */
export type ContributedCommand = {
  name: string;
  description?: string;
  argumentHint?: string;
  /** Immutable command instructions selected from the extension generation. */
  content?: string;
  /** Plugin / namespace the command belongs to. */
  namespace?: string;
};

export type ContributedSkill = {
  name: string;
  description?: string;
  /** Absolute path to the resolved SKILL.md selected by the runtime. */
  path: string;
  /** Parsed Markdown body when the provider can retain it in the snapshot. */
  content?: string;
  namespace?: string;
};

export type McpServerInstruction = {
  serverName: string;
  instructions?: string;
};

/** Read-only prompt section projected from a loaded extension. */
export type ContributedPrompt = {
  /** Stable, namespaced contribution name used by the session registry. */
  name: string;
  content: string;
  namespace?: string;
};

/** A tool definition selected from an extension generation. */
export type ContributedTool = {
  namespace?: string;
  tool: PilotDeckToolDefinition;
};

export interface ExtensionResolver {
  listCommands(): ContributedCommand[];
  listSkills(): ContributedSkill[];
  /** Optional programmatic tools selected from the same extension generation. */
  listToolContributions?(): ContributedTool[];
  /** Optional prompt sections supplied by programmatic extensions. */
  listPromptContributions?(): ContributedPrompt[];
  /**
   * Phase 6 returns []; the real MCP runtime wires this once the connect /
   * handshake layer is in place (see deferred `context-mcp-instructions`).
   */
  listMcpInstructions(): McpServerInstruction[];
}

export class NullExtensionResolver implements ExtensionResolver {
  listCommands(): ContributedCommand[] {
    return [];
  }
  listSkills(): ContributedSkill[] {
    return [];
  }
  listToolContributions(): ContributedTool[] {
    return [];
  }
  listPromptContributions(): ContributedPrompt[] {
    return [];
  }
  listMcpInstructions(): McpServerInstruction[] {
    return [];
  }
}
import type { PilotDeckToolDefinition } from "../../tool/protocol/types.js";
