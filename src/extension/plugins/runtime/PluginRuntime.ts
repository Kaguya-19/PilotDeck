import { resolvePluginDirectories } from "../discovery/PluginDirectoryResolver.js";
import {
  discoverPluginPaths,
  discoverSkillPaths,
  type DiscoveredPluginPath,
} from "../discovery/discoverLocalPlugins.js";
import {
  loadPluginFromPath,
  loadPluginOutputStylesFromPath,
  loadSkillFromPath,
} from "../loading/PluginLoader.js";
import { loadPluginHooks } from "../loading/PluginHookLoader.js";
import type { LoadedPluginCommand } from "../loading/PluginCommandLoader.js";
import type { PilotDeckLoadedPlugin } from "../protocol/plugin.js";
import { PluginRegistry, type PluginRegistryLease } from "./PluginRegistry.js";
import { truncateMcpInstructionString } from "./truncateMcpString.js";
import type { PilotDeckHooksSettings } from "../../hooks/protocol/settings.js";
import type { PilotDeckToolDefinition } from "../../../tool/protocol/types.js";
import { renderSkillContent } from "../../skills/renderSkillContent.js";
import type { RouterContribution } from "../../contributions/RouterContribution.js";
import type { PilotDeckCustomRouter } from "../../../router/customRouter/customRouter.js";

/**
 * Static MCP server contribution shape callers can rely on. Manifests load
 * `mcpServers` as `Record<string, unknown>` to stay forward-compatible, so
 * this type is *advisory* — the runtime only reads `instructions` and falls
 * back gracefully when missing.
 */
export type PilotDeckMcpServerStaticSpec = {
  instructions?: string;
  [key: string]: unknown;
};

/**
 * Aggregated B3 instruction entry (always non-empty `instructions`). Exposed
 * as a stricter alias of {@link PluginMcpInstruction} so callers that only
 * care about *populated* entries keep a non-optional `instructions` field.
 */
export type PilotDeckMcpInstructionEntry = {
  serverName: string;
  instructions: string;
};

export type PluginRuntimeOptions = {
  projectRoot: string;
  pilotHome: string;
  /** Read-only skills shipped with the active PilotDeck build. */
  builtinSkillsRoot?: string;
  builtinPlugins?: PilotDeckLoadedPlugin[];
  builtinPluginsEnabled?: Record<string, boolean>;
};

export type PluginRefreshResult = {
  generation: number;
  previous: PilotDeckLoadedPlugin[];
  next: PilotDeckLoadedPlugin[];
  added: PilotDeckLoadedPlugin[];
  removed: PilotDeckLoadedPlugin[];
  /** Disk candidates that could not be loaded during staging. */
  stagedFailures: PluginRefreshFailure[];
};

export type PluginRefreshFailure = {
  path: string;
  source: PilotDeckLoadedPlugin["source"];
  kind: "plugin" | "skill";
};

export type PluginCommandContribution = {
  name: string;
  description?: string;
  argumentHint?: string;
  /** Command instructions from the exact plugin generation. */
  content?: string;
  namespace?: string;
};

export type PluginSkillContribution = {
  name: string;
  description?: string;
  /** Absolute path to the resolved SKILL.md. */
  path: string;
  /** Parsed Markdown body retained with the immutable plugin generation. */
  content?: string;
  namespace?: string;
};

export type PluginMcpInstruction = {
  serverName: string;
  instructions?: string;
};

/** A frozen plugin tool definition together with its source namespace. */
export type PluginToolContribution = {
  namespace: string;
  tool: PilotDeckToolDefinition;
};

/** A custom-router contribution retained with one plugin generation. */
export type PluginRouterContribution = {
  namespace: string;
  contribution: RouterContribution;
};

export type PluginPromptContribution = {
  name: string;
  namespace: string;
  content: string;
};

export type OutputStyleContribution = {
  name: string;
  description?: string;
  content: string;
  path: string;
  plugin?: string;
  source?: PilotDeckLoadedPlugin["source"];
};

/** Read-only contribution view over a fixed plugin generation. */
export class PluginRuntimeView {
  constructor(private readonly plugins: readonly PilotDeckLoadedPlugin[]) {}

  snapshot(): PilotDeckLoadedPlugin[] {
    return [...this.plugins];
  }

  mcpServers(): Record<string, unknown> {
    return collectMcpServers(this.plugins);
  }

  getAllMcpInstructions(): PilotDeckMcpInstructionEntry[] {
    return collectMcpInstructions(this.plugins);
  }

  snapshotContributions(): PluginContributionSnapshot {
    return createContributionSnapshot({ generation: 0, plugins: this.plugins });
  }

  listOutputStyles(): OutputStyleContribution[] {
    return this.plugins
      .flatMap((plugin) => (plugin.outputStyles ?? []).map((style) => toOutputStyle(plugin, style)))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  getOutputStyle(name: string): OutputStyleContribution | undefined {
    return this.listOutputStyles().find((style) => style.name === name);
  }

  getAllCommands(): PluginCommandContribution[] {
    return collectCommandContributions(this.plugins);
  }

  getAllSkills(): PluginSkillContribution[] {
    return collectSkillContributions(this.plugins);
  }

  lookupRouter(extensionId: string): PilotDeckCustomRouter | undefined {
    return collectPluginRouterContributions(this.plugins)
      .find((entry) => entry.contribution.id === extensionId)
      ?.contribution.createCustomRouter();
  }

  async loadSkillPrompt(extensionId: string): Promise<string | undefined> {
    const plugins = sortByResolutionPriority([...this.plugins]);
    for (const plugin of plugins) {
      const prompt = plugin.promptContributions?.find((entry) => entry.name === extensionId);
      if (prompt) return prompt.content;
    }
    for (const plugin of plugins) {
      const skill = plugin.skills?.find((entry) => entry.name === extensionId || entry.name.endsWith(`:${extensionId}`));
      if (skill) return renderSkillContent(skill.content, skill.path);
    }
    for (const plugin of plugins) {
      const command = plugin.commands?.find((entry) => entry.name === extensionId || entry.name.endsWith(`:${extensionId}`));
      if (command) return command.content;
    }
    return undefined;
  }
}

export type PluginSessionContributionSnapshot = Readonly<{
  generation: number;
  tools: readonly PluginToolContribution[];
  routers: readonly PluginRouterContribution[];
  commands: readonly PluginCommandContribution[];
  skills: readonly PluginSkillContribution[];
  prompts: readonly PluginPromptContribution[];
  hooks: Readonly<PilotDeckHooksSettings>;
  mcpServers: Readonly<Record<string, unknown>>;
  mcpInstructions: readonly PluginMcpInstruction[];
}>;

export type PluginCommandCatalogSnapshot = Readonly<{
  generation: number;
  commands: readonly PluginCommandContribution[];
}>;

export type PluginSessionContributionLease = {
  readonly generation: number;
  readonly contributions: PluginSessionContributionSnapshot;
  release(): Promise<void>;
};

export type PluginCommandCatalogLease = {
  readonly generation: number;
  readonly contributions: PluginCommandCatalogSnapshot;
  release(): Promise<void>;
};

/** @deprecated Use a consumer-specific session or command catalog snapshot. */
export type PluginContributionSnapshot = {
  generation: number;
  plugins: PilotDeckLoadedPlugin[];
  tools: PluginToolContribution[];
  routers: PluginRouterContribution[];
  commands: PluginCommandContribution[];
  skills: PluginSkillContribution[];
  outputStyles: LoadedPluginCommand[];
  hooks: PilotDeckHooksSettings;
  mcpServers: Record<string, unknown>;
  lspServers: Record<string, unknown>;
  mcpInstructions: PluginMcpInstruction[];
};

/**
 * @deprecated Use PluginSessionContributionLease or PluginCommandCatalogLease.
 *
 * A session-scoped retain on one immutable plugin contribution generation.
 * Releasing it permits a retired plugin instance to run its disposer.
 */
export type PluginContributionLease = {
  readonly generation: number;
  readonly contributions: PluginContributionSnapshot;
  release(): Promise<void>;
};

export class PluginRuntime {
  private readonly registry = new PluginRegistry();
  private readonly outputStyleRegistry = new Map<string, OutputStyleContribution>();
  private refreshPromise?: Promise<PluginRefreshResult>;
  private disposalPromise?: Promise<void>;
  private disposalRequested = false;

  constructor(private readonly options: PluginRuntimeOptions) {}

  snapshot(): PilotDeckLoadedPlugin[] {
    return this.registry.list();
  }

  createView(additional: readonly PilotDeckLoadedPlugin[] = []): PluginRuntimeView {
    return new PluginRuntimeView([...this.registry.list(), ...additional]);
  }

  get lifecycleState() {
    return this.registry.state;
  }

  get generation(): number {
    return this.registry.currentGeneration;
  }

  dispose(): Promise<void> {
    if (this.disposalPromise) return this.disposalPromise;
    this.disposalRequested = true;
    const pendingRefresh = this.refreshPromise;
    this.disposalPromise = (async () => {
      await pendingRefresh?.catch(() => undefined);
      await this.registry.dispose();
    })();
    return this.disposalPromise;
  }

  mcpServers(): Record<string, unknown> {
    return Object.assign({}, ...this.registry.list().map((plugin) => plugin.mcpServers ?? {})) as Record<string, unknown>;
  }

  /**
   * Read-only static instructions aggregator (deferred-feature §5.3 / B3).
   * - Iterates `mcpServers` from every loaded plugin.
   * - Filters entries with a non-empty `instructions: string` field.
   * - Truncates each entry to {@link truncateMcpInstructionString} (2048 chars).
   * - Returns a stable list sorted by `serverName` (avoids prompt-cache thrash).
   *
   * Once C1 (real MCP runtime) lands, the runtime can layer dynamic
   * instructions on top via the same `getAllMcpInstructions` aggregator
   * surface used by `PluginRuntimeExtensionResolver`.
   */
  getAllMcpInstructions(): PilotDeckMcpInstructionEntry[] {
    const entries: PilotDeckMcpInstructionEntry[] = [];
    const seen = new Set<string>();
    for (const plugin of this.registry.list()) {
      const servers = plugin.mcpServers;
      if (!servers || typeof servers !== "object") continue;
      for (const [serverName, raw] of Object.entries(servers)) {
        if (seen.has(serverName)) continue;
        if (!raw || typeof raw !== "object") continue;
        const candidate = (raw as PilotDeckMcpServerStaticSpec).instructions;
        if (typeof candidate !== "string") continue;
        const trimmed = candidate.trim();
        if (trimmed.length === 0) continue;
        seen.add(serverName);
        entries.push({
          serverName,
          instructions: truncateMcpInstructionString(trimmed),
        });
      }
    }
    entries.sort((a, b) => a.serverName.localeCompare(b.serverName));
    return entries;
  }

  lspServers(): Record<string, unknown> {
    return Object.assign({}, ...this.registry.list().map((plugin) => plugin.lspServers ?? {})) as Record<string, unknown>;
  }

  /** @deprecated Use snapshotSessionContributions or snapshotCommandCatalog. */
  snapshotContributions(): PluginContributionSnapshot {
    return createContributionSnapshot({
      generation: this.registry.currentGeneration,
      plugins: this.registry.list(),
    });
  }

  snapshotSessionContributions(): PluginSessionContributionSnapshot {
    return createSessionContributionSnapshot({
      generation: this.registry.currentGeneration,
      plugins: this.registry.list(),
    });
  }

  acquireSessionContributions(
    additionalPlugins: readonly PilotDeckLoadedPlugin[] = [],
  ): PluginSessionContributionLease {
    const lease = this.registry.acquire();
    return {
      generation: lease.generation,
      contributions: createSessionContributionSnapshot({
        generation: lease.generation,
        plugins: [...lease.plugins, ...additionalPlugins],
      }),
      release: () => lease.release(),
    };
  }

  snapshotCommandCatalog(): PluginCommandCatalogSnapshot {
    return createCommandCatalogSnapshot({
      generation: this.registry.currentGeneration,
      plugins: this.registry.list(),
    });
  }

  acquireCommandCatalog(): PluginCommandCatalogLease {
    const lease = this.registry.acquire();
    return {
      generation: lease.generation,
      contributions: createCommandCatalogSnapshot(lease),
      release: () => lease.release(),
    };
  }

  /** @deprecated Use acquireSessionContributions or acquireCommandCatalog. */
  acquireContributionSnapshot(): PluginContributionLease {
    const lease = this.registry.acquire();
    return {
      generation: lease.generation,
      contributions: createContributionSnapshot(lease),
      release: () => lease.release(),
    };
  }

  listOutputStyles(): OutputStyleContribution[] {
    return [...this.outputStyleRegistry.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((style) => ({ ...style }));
  }

  getOutputStyle(name: string): OutputStyleContribution | undefined {
    const style = this.outputStyleRegistry.get(name);
    return style ? { ...style } : undefined;
  }

  /**
   * Refresh only output-style files. Other plugin contributions stay in the
   * existing registry, so a style reload cannot change hooks, commands, MCP,
   * skills, or routers for an active project runtime.
   */
  async reloadOutputStyles(): Promise<{ changed: string[] }> {
    const paths = resolvePluginDirectories({
      projectRoot: this.options.projectRoot,
      pilotHome: this.options.pilotHome,
    });
    const discovered = await discoverPluginPaths([
      { path: paths.globalPluginsDir, source: "global" },
      { path: paths.projectPluginsDir, source: "project" },
    ]);
    const next = new Map<string, OutputStyleContribution>();
    for (const plugin of this.options.builtinPlugins ?? []) {
      for (const style of plugin.outputStyles ?? []) {
        next.set(style.name, toOutputStyle(plugin, style));
      }
    }
    for (const plugin of discovered) {
      try {
        const loaded = await loadPluginOutputStylesFromPath(plugin.path, plugin.source);
        for (const style of loaded.outputStyles) {
          next.set(style.name, {
            name: style.name,
            description: typeof style.frontmatter.description === "string" ? style.frontmatter.description : undefined,
            content: style.content,
            path: style.path,
            plugin: loaded.name,
            source: loaded.source,
          });
        }
      } catch {
        // A malformed style is omitted from the new registry; unrelated
        // plugin contributions remain available and are not reloaded.
      }
    }
    const changed = [...new Set([
      ...this.outputStyleRegistry.keys(),
      ...next.keys(),
    ])].filter((key) => JSON.stringify(this.outputStyleRegistry.get(key)) !== JSON.stringify(next.get(key)));
    this.outputStyleRegistry.clear();
    for (const [key, style] of next) this.outputStyleRegistry.set(key, style);
    return { changed };
  }

  getAllCommands(): PluginCommandContribution[] {
    return [...this.snapshotCommandCatalog().commands];
  }

  getAllSkills(): PluginSkillContribution[] {
    return [...this.snapshotSessionContributions().skills];
  }

  async loadSkillPrompt(extensionId: string): Promise<string | undefined> {
    const plugins = sortByResolutionPriority(this.registry.list());

    for (const plugin of plugins) {
      const prompt = plugin.promptContributions?.find((contribution) => contribution.name === extensionId);
      if (prompt) {
        return prompt.content;
      }
    }

    for (const plugin of plugins) {
      const skill = plugin.skills?.find((entry) => entry.name === extensionId);
      if (skill) {
        return renderSkillContent(skill.content, skill.path);
      }
    }

    // Resolve namespaced plugin skills by their short name only after exact
    // standalone names have had a chance to resolve.
    for (const plugin of plugins) {
      const skill = plugin.skills?.find((entry) => entry.name.endsWith(`:${extensionId}`));
      if (skill) {
        return renderSkillContent(skill.content, skill.path);
      }
    }

    for (const plugin of plugins) {
      const command = plugin.commands?.find((entry) => entry.name === extensionId || entry.name.endsWith(`:${extensionId}`));
      if (command) {
        return command.content;
      }
    }
    return undefined;
  }

  async refresh(): Promise<PilotDeckLoadedPlugin[]> {
    return (await this.refreshWithReport()).next;
  }

  async refreshWithReport(): Promise<PluginRefreshResult> {
    if (this.disposalRequested) {
      throw new Error("Cannot refresh plugins; plugin runtime is draining.");
    }
    if (this.refreshPromise) return this.refreshPromise;
    const pending = this.performRefreshWithReport();
    this.refreshPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.refreshPromise === pending) this.refreshPromise = undefined;
    }
  }

  private async performRefreshWithReport(): Promise<PluginRefreshResult> {
    const previous = this.registry.list();
    const paths = resolvePluginDirectories({
      projectRoot: this.options.projectRoot,
      pilotHome: this.options.pilotHome,
    });
    const [discovered, discoveredSkills, loadedBuiltins] = await Promise.all([
      discoverPluginPaths([
        { path: paths.globalPluginsDir, source: "global" },
        { path: paths.projectPluginsDir, source: "project" },
      ]),
      discoverSkillPaths([
        ...(this.options.builtinSkillsRoot
          ? [{ path: this.options.builtinSkillsRoot, source: "builtin" as const }]
          : []),
        { path: paths.globalSkillsDir, source: "global" },
        { path: paths.projectSkillsDir, source: "project" },
      ]),
      Promise.all(
        (this.options.builtinPlugins ?? []).map((plugin) =>
          loadPluginFromPath(plugin.path, "builtin").catch(() => plugin),
        ),
      ),
    ]);
    const [pluginAttempts, skillAttempts] = await Promise.all([
      Promise.all(
        discovered.map((plugin) => loadPluginAttempt(plugin)),
      ),
      Promise.all(
        discoveredSkills.map((skill) => loadSkillAttempt(skill)),
      ),
    ]);
    const attempts = [...pluginAttempts, ...skillAttempts];
    const successfulPaths = new Set(
      attempts
        .filter((attempt): attempt is PluginLoadAttempt & { plugin: PilotDeckLoadedPlugin } => attempt.plugin !== undefined)
        .map((attempt) => discoveredPathKey(attempt.candidate)),
    );
    const stagedFailures = attempts
      .filter((attempt) => attempt.plugin === undefined && !successfulPaths.has(discoveredPathKey(attempt.candidate)))
      .map((attempt) => ({
        path: attempt.candidate.path,
        source: attempt.candidate.source,
        kind: attempt.kind,
      }));

    // Refresh is a staging transaction for active disk contributions. If an
    // existing source path is still present but no longer loadable, publishing
    // a partial generation would revoke tools/MCP/hooks from live sessions.
    // Keep the old generation intact; a real deletion has no discovered path
    // and therefore continues through normal retirement below.
    if (stagedFailures.some((failure) => previous.some((plugin) => matchesDiscoveredPath(plugin, failure)))) {
      return {
        generation: this.registry.currentGeneration,
        previous,
        next: previous,
        added: [],
        removed: [],
        stagedFailures,
      };
    }
    const plugins = [
      ...enabledBuiltinPlugins(loadedBuiltins, this.options.builtinPluginsEnabled ?? {}),
      ...attempts.flatMap((attempt) => attempt.plugin ? [attempt.plugin] : []),
    ];
    const replacement = this.registry.replaceAll(plugins);
    const retirement = replacement.disposeRemoved();
    if (replacement.retiringLeaseCount === 0) {
      await retirement;
    } else {
      // A session retaining this generation observes disposal failure during
      // its own release. New sessions must select the published generation
      // instead of waiting for an unrelated active session to finish.
      void retirement.catch(() => undefined);
    }
    this.outputStyleRegistry.clear();
    for (const plugin of plugins) {
      for (const style of plugin.outputStyles ?? []) {
        this.outputStyleRegistry.set(style.name, toOutputStyle(plugin, style));
      }
    }
    return {
      generation: replacement.generation,
      previous,
      next: plugins,
      added: plugins.filter((plugin) => !hasPlugin(previous, plugin)),
      removed: previous.filter((plugin) => !hasPlugin(plugins, plugin)),
      stagedFailures,
    };
  }
}

type PluginLoadAttempt = {
  candidate: DiscoveredPluginPath;
  kind: "plugin" | "skill";
  plugin?: PilotDeckLoadedPlugin;
};

async function loadPluginAttempt(candidate: DiscoveredPluginPath): Promise<PluginLoadAttempt> {
  try {
    return {
      candidate,
      kind: "plugin",
      plugin: await loadPluginFromPath(candidate.path, candidate.source),
    };
  } catch {
    return { candidate, kind: "plugin" };
  }
}

async function loadSkillAttempt(candidate: DiscoveredPluginPath): Promise<PluginLoadAttempt> {
  try {
    return {
      candidate,
      kind: "skill",
      plugin: await loadSkillFromPath(candidate.path, candidate.source),
    };
  } catch {
    return { candidate, kind: "skill" };
  }
}

function discoveredPathKey(candidate: DiscoveredPluginPath): string {
  return `${candidate.source}:${candidate.path}`;
}

function matchesDiscoveredPath(plugin: PilotDeckLoadedPlugin, candidate: PluginRefreshFailure): boolean {
  return plugin.source === candidate.source && plugin.path === candidate.path;
}

function createContributionSnapshot(input: {
  generation: number;
  plugins: readonly PilotDeckLoadedPlugin[];
}): PluginContributionSnapshot {
  const plugins = [...input.plugins];
  return {
    generation: input.generation,
    plugins,
    tools: collectPluginToolContributions(plugins),
    routers: collectPluginRouterContributions(plugins),
    commands: collectCommandContributions(plugins),
    skills: collectSkillContributions(plugins),
    outputStyles: plugins.flatMap((plugin) => plugin.outputStyles ?? []),
    hooks: loadPluginHooks(plugins),
    mcpServers: collectMcpServers(plugins),
    lspServers: collectLspServers(plugins),
    mcpInstructions: collectMcpInstructions(plugins),
  };
}

function createSessionContributionSnapshot(input: {
  generation: number;
  plugins: readonly PilotDeckLoadedPlugin[];
}): PluginSessionContributionSnapshot {
  const plugins = [...input.plugins];
  return Object.freeze({
    generation: input.generation,
    tools: Object.freeze(collectPluginToolContributions(plugins)),
    routers: Object.freeze(collectPluginRouterContributions(plugins)),
    commands: Object.freeze(collectCommandContributions(plugins)),
    skills: Object.freeze(collectSkillContributions(plugins)),
    prompts: Object.freeze(collectPluginPromptContributions(plugins)),
    hooks: Object.freeze(loadPluginHooks(plugins)),
    mcpServers: Object.freeze(collectMcpServers(plugins)),
    mcpInstructions: Object.freeze(collectMcpInstructions(plugins)),
  });
}

function createCommandCatalogSnapshot(input: {
  generation: number;
  plugins: readonly PilotDeckLoadedPlugin[];
}): PluginCommandCatalogSnapshot {
  return Object.freeze({
    generation: input.generation,
    commands: Object.freeze(collectCommandContributions(input.plugins)),
  });
}

function collectMcpServers(plugins: readonly PilotDeckLoadedPlugin[]): Record<string, unknown> {
  return Object.assign({}, ...plugins.map((plugin) => plugin.mcpServers ?? {})) as Record<string, unknown>;
}

function collectLspServers(plugins: readonly PilotDeckLoadedPlugin[]): Record<string, unknown> {
  return Object.assign({}, ...plugins.map((plugin) => plugin.lspServers ?? {})) as Record<string, unknown>;
}

function collectMcpInstructions(plugins: readonly PilotDeckLoadedPlugin[]): PilotDeckMcpInstructionEntry[] {
  const entries: PilotDeckMcpInstructionEntry[] = [];
  const seen = new Set<string>();
  for (const plugin of plugins) {
    const servers = plugin.mcpServers;
    if (!servers || typeof servers !== "object") continue;
    for (const [serverName, raw] of Object.entries(servers)) {
      if (seen.has(serverName)) continue;
      if (!raw || typeof raw !== "object") continue;
      const candidate = (raw as PilotDeckMcpServerStaticSpec).instructions;
      if (typeof candidate !== "string") continue;
      const trimmed = candidate.trim();
      if (trimmed.length === 0) continue;
      seen.add(serverName);
      entries.push({
        serverName,
        instructions: truncateMcpInstructionString(trimmed),
      });
    }
  }
  entries.sort((a, b) => a.serverName.localeCompare(b.serverName));
  return entries;
}

function enabledBuiltinPlugins(
  plugins: PilotDeckLoadedPlugin[],
  enabled: Record<string, boolean>,
): PilotDeckLoadedPlugin[] {
  return plugins.filter((plugin) => plugin.source !== "builtin" || enabled[plugin.name] !== false);
}

function hasPlugin(plugins: PilotDeckLoadedPlugin[], plugin: PilotDeckLoadedPlugin): boolean {
  return plugins.some((candidate) => candidate.name === plugin.name && candidate.source === plugin.source);
}

function toCommandContribution(
  plugin: PilotDeckLoadedPlugin,
  command: LoadedPluginCommand,
): PluginCommandContribution {
  return {
    name: command.name,
    description: typeof command.frontmatter.description === "string" ? command.frontmatter.description : undefined,
    argumentHint:
      typeof command.frontmatter["argument-hint"] === "string"
        ? command.frontmatter["argument-hint"]
        : undefined,
    content: command.content,
    namespace: plugin.name,
  };
}

function toOutputStyle(
  plugin: PilotDeckLoadedPlugin,
  style: LoadedPluginCommand,
): OutputStyleContribution {
  return {
    name: style.name,
    description: typeof style.frontmatter.description === "string" ? style.frontmatter.description : undefined,
    content: style.content,
    path: style.path,
    plugin: plugin.name,
    source: plugin.source,
  };
}

/**
 * Select one immutable command body per model-facing command name. Plugin
 * discovery order is not a command-resolution policy: project overrides
 * global, which overrides builtin, matching the existing skill contract.
 */
function collectCommandContributions(plugins: readonly PilotDeckLoadedPlugin[]): PluginCommandContribution[] {
  const selected = new Map<string, { contribution: PluginCommandContribution; priority: number }>();
  for (const plugin of plugins) {
    const priority = sourcePriority(plugin.source);
    for (const command of plugin.commands ?? []) {
      const contribution = toCommandContribution(plugin, command);
      const existing = selected.get(contribution.name);
      if (!existing || priority >= existing.priority) {
        selected.set(contribution.name, { contribution, priority });
      }
    }
  }
  return [...selected.values()]
    .map((entry) => entry.contribution)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function toSkillContribution(
  plugin: PilotDeckLoadedPlugin,
  skill: LoadedPluginCommand,
): PluginSkillContribution {
  return {
    name: skill.name,
    description: typeof skill.frontmatter.description === "string" ? skill.frontmatter.description : undefined,
    path: skill.path,
    content: skill.content,
    namespace: plugin.name,
  };
}

function sourcePriority(source: PilotDeckLoadedPlugin["source"]): number {
  switch (source) {
    case "project":
      return 2;
    case "global":
      return 1;
    case "builtin":
    default:
      return 0;
  }
}

export function collectPluginPromptContributions(
  plugins: readonly PilotDeckLoadedPlugin[],
): PluginPromptContribution[] {
  const selected = new Map<string, { contribution: PluginPromptContribution; priority: number }>();
  for (const plugin of plugins) {
    const priority = sourcePriority(plugin.source);
    for (const prompt of plugin.promptContributions ?? []) {
      const rawName = prompt.name.trim();
      if (rawName.length === 0 || prompt.content.trim().length === 0) continue;
      const name = `${plugin.name}:${rawName}`;
      const existing = selected.get(name);
      if (!existing || priority >= existing.priority) {
        selected.set(name, {
          priority,
          contribution: { name, namespace: plugin.name, content: prompt.content },
        });
      }
    }
  }
  return [...selected.values()]
    .map((entry) => entry.contribution)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function sortByResolutionPriority(plugins: PilotDeckLoadedPlugin[]): PilotDeckLoadedPlugin[] {
  return [...plugins].sort((a, b) => sourcePriority(b.source) - sourcePriority(a.source));
}

/**
 * Select one deterministic definition per model-visible tool name. The
 * project/global/builtin precedence mirrors prompt and skill resolution;
 * ties use the plugin name so filesystem discovery order never changes a
 * session's tool schema.
 */
export function collectPluginToolContributions(
  plugins: readonly PilotDeckLoadedPlugin[],
): PluginToolContribution[] {
  const selected = new Map<string, { contribution: PluginToolContribution; priority: number }>();
  for (const plugin of plugins) {
    const priority = sourcePriority(plugin.source);
    for (const group of plugin.toolContributions ?? []) {
      for (const tool of group.tools) {
        const name = tool.name.trim();
        if (name.length === 0) continue;
        const contribution: PluginToolContribution = {
          namespace: plugin.name,
          tool: cloneToolDefinition(tool),
        };
        const existing = selected.get(name);
        if (
          !existing
          || priority > existing.priority
          || (priority === existing.priority && contribution.namespace.localeCompare(existing.contribution.namespace) < 0)
        ) {
          selected.set(name, { contribution, priority });
        }
      }
    }
  }
  return [...selected.values()]
    .map((entry) => entry.contribution)
    .sort((left, right) => left.tool.name.localeCompare(right.tool.name));
}

function collectPluginRouterContributions(
  plugins: readonly PilotDeckLoadedPlugin[],
): PluginRouterContribution[] {
  const selected = new Map<string, { contribution: PluginRouterContribution; priority: number }>();
  for (const plugin of plugins) {
    const priority = sourcePriority(plugin.source);
    for (const router of plugin.routerContributions ?? []) {
      const id = router.id.trim();
      if (id.length === 0) continue;
      const contribution: PluginRouterContribution = { namespace: plugin.name, contribution: router };
      const existing = selected.get(id);
      if (
        !existing
        || priority > existing.priority
        || (priority === existing.priority && contribution.namespace.localeCompare(existing.contribution.namespace) < 0)
      ) {
        selected.set(id, { contribution, priority });
      }
    }
  }
  return [...selected.values()]
    .map((entry) => entry.contribution)
    .sort((left, right) => left.contribution.id.localeCompare(right.contribution.id));
}

function cloneToolDefinition(tool: PilotDeckToolDefinition): PilotDeckToolDefinition {
  return {
    ...tool,
    ...(tool.aliases ? { aliases: [...tool.aliases] } : {}),
    ...(tool.requiredRuntimeCapabilities ? { requiredRuntimeCapabilities: [...tool.requiredRuntimeCapabilities] } : {}),
  };
}

function collectSkillContributions(plugins: readonly PilotDeckLoadedPlugin[]): PluginSkillContribution[] {
  const selected = new Map<string, { contribution: PluginSkillContribution; priority: number }>();
  for (const plugin of plugins) {
    const priority = sourcePriority(plugin.source);
    for (const skill of plugin.skills ?? []) {
      const contribution = toSkillContribution(plugin, skill);
      const existing = selected.get(contribution.name);
      if (!existing || priority >= existing.priority) {
        selected.set(contribution.name, { contribution, priority });
      }
    }
  }
  return [...selected.values()].map((entry) => entry.contribution);
}
