import type { CanonicalContentBlock, CanonicalMessage } from "../../model/index.js";
import type { ContributedCommand, ExtensionResolver } from "../extension/ExtensionResolver.js";
import { NullExtensionResolver } from "../extension/ExtensionResolver.js";

export type ContextInputBlock =
  | { type: "text"; text: string; isMeta?: boolean }
  | { type: "blocks"; content: CanonicalContentBlock[]; isMeta?: boolean };

export type ContextInputResult = {
  /** Messages produced for the conversation log. */
  messages: CanonicalMessage[];
  /** Whether the agent loop should call the model after this input. */
  shouldCallModel: boolean;
  /** Diagnostics emitted while processing (e.g. unknown command). */
  diagnostics: Array<{ code: string; severity: "info" | "warning" | "error"; message: string }>;
  /** Recognized command (if any). */
  command?: { name: string; argument?: string; source: "extension" | "unknown" };
};

export type InputProcessorOptions = {
  extension?: ExtensionResolver;
};

const SLASH_COMMAND_RE = /^\/(?<name>[A-Za-z0-9_:-]+)(?<sep>\s+|$)/;

/**
 * Phase 4 input processor (review decision §3.2 — three-layer slash command):
 *  - adapter pre-parses `/foo` token; passes raw input here
 *  - this processor checks `extension.listCommands()` for a match
 *  - if matched: produces a bounded, delimited command body + argument
 *    message (still triggers a model call so plugin command bodies get
 *    summarized / executed by the agent loop)
 *  - if unmatched: passes through as plain text and flags an `unknown_command`
 *    diagnostic
 *
 * The resolver is session-scoped. It must be constructed from the same frozen
 * extension snapshot as the session's tools and prompts, so reload cannot
 * change an existing session's command semantics.
 */
export const MAX_PLUGIN_COMMAND_BODY_CHARS = 32_000;
export const MAX_PLUGIN_COMMAND_ARGUMENT_CHARS = 8_000;

export class InputProcessor {
  private readonly extension: ExtensionResolver;

  constructor(options: InputProcessorOptions = {}) {
    this.extension = options.extension ?? new NullExtensionResolver();
  }

  process(input: ContextInputBlock): ContextInputResult {
    if (input.type === "blocks") {
      return {
        messages: [{ role: "user", content: cloneBlocks(input.content) }],
        shouldCallModel: !input.isMeta,
        diagnostics: [],
      };
    }

    const trimmed = input.text;
    const match = trimmed.match(SLASH_COMMAND_RE);
    if (!match) {
      return {
        messages: [{ role: "user", content: [{ type: "text", text: trimmed }] }],
        shouldCallModel: !input.isMeta,
        diagnostics: [],
      };
    }

    const commandName = match.groups?.name ?? "";
    const argument = trimmed.slice(match[0].length);
    const command = this.findCommand(commandName);
    if (!command) {
      return {
        messages: [{ role: "user", content: [{ type: "text", text: trimmed }] }],
        shouldCallModel: !input.isMeta,
        diagnostics: [
          {
            code: "unknown_command",
            severity: "warning",
            message: `Slash command /${commandName} is not registered. Forwarding as plain text.`,
          },
        ],
        command: { name: commandName, argument: argument || undefined, source: "unknown" },
      };
    }

    const rendered = renderPluginCommand(commandName, command, argument);
    return {
      messages: [{ role: "user", content: [{ type: "text", text: rendered.text }] }],
      shouldCallModel: !input.isMeta,
      diagnostics: rendered.diagnostics,
      command: { name: commandName, argument: argument || undefined, source: "extension" },
    };
  }

  /** Implements the Agent input-admission Definition without owning its turn. */
  accept(input: ContextInputBlock): ContextInputResult {
    return this.process(input);
  }

  private findCommand(name: string): ContributedCommand | undefined {
    return this.extension.listCommands().find((command) => command.name === name);
  }
}

function cloneBlocks(blocks: CanonicalContentBlock[]): CanonicalContentBlock[] {
  return blocks.map((block) => ({ ...block }));
}

function renderPluginCommand(
  commandName: string,
  command: ContributedCommand,
  argument: string,
): { text: string; diagnostics: ContextInputResult["diagnostics"] } {
  const body = command.content?.trim() ?? "";
  if (body.length === 0) {
    return {
      text: argument
        ? `Run plugin command "/${commandName}" with argument: ${argument}`
        : `Run plugin command "/${commandName}".`,
      diagnostics: [],
    };
  }

  const diagnostics: ContextInputResult["diagnostics"] = [];
  const boundedBody = truncateCommandSection(body, MAX_PLUGIN_COMMAND_BODY_CHARS);
  if (boundedBody.truncated) {
    diagnostics.push({
      code: "plugin_command_body_truncated",
      severity: "warning",
      message: `Plugin command /${commandName} body exceeded ${MAX_PLUGIN_COMMAND_BODY_CHARS} characters and was truncated.`,
    });
  }
  const boundedArgument = truncateCommandSection(argument, MAX_PLUGIN_COMMAND_ARGUMENT_CHARS);
  if (boundedArgument.truncated) {
    diagnostics.push({
      code: "plugin_command_argument_truncated",
      severity: "warning",
      message: `Plugin command /${commandName} argument exceeded ${MAX_PLUGIN_COMMAND_ARGUMENT_CHARS} characters and was truncated.`,
    });
  }

  const forbidden = `${boundedBody.value}\n${boundedArgument.value}`;
  const bodySection = formatDelimitedCommandSection("command-body", boundedBody.value, forbidden);
  const argumentSection = boundedArgument.value.length > 0
    ? `\n${formatDelimitedCommandSection("command-argument", boundedArgument.value, forbidden)}`
    : "";
  return {
    text: [
      `<plugin-command name="/${commandName}">`,
      bodySection,
      argumentSection,
      "</plugin-command>",
    ].join("\n"),
    diagnostics,
  };
}

function truncateCommandSection(value: string, limit: number): { value: string; truncated: boolean } {
  if (value.length <= limit) return { value, truncated: false };
  const marker = "\n[truncated by PilotDeck command admission]";
  return {
    value: `${value.slice(0, Math.max(0, limit - marker.length))}${marker}`,
    truncated: true,
  };
}

function formatDelimitedCommandSection(name: string, value: string, forbidden: string): string {
  let suffix = 0;
  let delimiter = `<<<PILOTDECK_${name.replaceAll("-", "_").toUpperCase()}_${suffix}>>>`;
  while (forbidden.includes(delimiter)) {
    suffix += 1;
    delimiter = `<<<PILOTDECK_${name.replaceAll("-", "_").toUpperCase()}_${suffix}>>>`;
  }
  return [`<${name}>`, delimiter, value, delimiter, `</${name}>`].join("\n");
}
