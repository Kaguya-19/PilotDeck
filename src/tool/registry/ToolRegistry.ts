import type { CanonicalToolSchema } from "../../model/index.js";
import type {
  PilotDeckToolAvailability,
  PilotDeckToolDefinition,
} from "../protocol/types.js";
import type { ToolCapabilityPolicy } from "./ToolCapabilityPolicy.js";

export type ToolUnavailableDiagnostic = {
  toolName: string;
  code: Exclude<PilotDeckToolAvailability, { ok: true }>["code"];
  reason: string;
};

export type ToolUnavailableDiagnosticEntry = {
  diagnostic: ToolUnavailableDiagnostic;
  aliases: string[];
};

export type ToolRegistryOptions = {
  parent?: ToolRegistry;
  policy?: ToolCapabilityPolicy;
};

export type ToolRegistryState = "active" | "disposed";

export type ToolRegistration = {
  readonly name: string;
  readonly active: boolean;
  dispose(): void;
};

export class ToolRegistry {
  private readonly toolsByName = new Map<string, PilotDeckToolDefinition>();
  private readonly aliases = new Map<string, string>();
  private readonly unavailable = new Map<string, ToolUnavailableDiagnostic>();
  /** Deferred tools remain executable only after search_tools reveals them. */
  private readonly hidden = new Set<string>();
  private readonly registrations = new Map<string, ToolRegistrationImpl>();

  private readonly parent?: ToolRegistry;
  private readonly policy?: ToolCapabilityPolicy;
  private registryState: ToolRegistryState = "active";

  constructor(options: ToolRegistryOptions = {}) {
    this.parent = options.parent;
    this.policy = options.policy;
  }

  get state(): ToolRegistryState {
    return this.registryState;
  }

  register(tool: PilotDeckToolDefinition): ToolRegistration {
    this.assertActive("register a tool");
    if (this.toolsByName.has(tool.name)) {
      throw new Error(`Tool ${tool.name} is already registered.`);
    }

    if (this.aliases.has(tool.name)) {
      throw new Error(`Tool ${tool.name} conflicts with an existing alias.`);
    }

    for (const alias of tool.aliases ?? []) {
      if (this.toolsByName.has(alias)) {
        throw new Error(`Alias ${alias} conflicts with an existing tool name.`);
      }
      if (this.aliases.has(alias)) {
        throw new Error(`Alias ${alias} is already registered.`);
      }
    }

    this.toolsByName.set(tool.name, tool);
    this.unavailable.delete(tool.name);
    for (const alias of tool.aliases ?? []) {
      this.aliases.set(alias, tool.name);
      this.unavailable.delete(alias);
    }
    let registration: ToolRegistrationImpl;
    registration = new ToolRegistrationImpl(tool.name, () => {
      if (this.toolsByName.get(tool.name) !== tool) return;
      this.removeLocalTool(tool);
    });
    this.registrations.set(tool.name, registration);
    return registration;
  }

  get(name: string): PilotDeckToolDefinition | undefined {
    if (this.registryState !== "active") return undefined;
    const realName = this.aliases.get(name) ?? name;
    const local = this.toolsByName.get(realName);
    if (local) return this.isVisible(local) ? local : undefined;
    const inherited = this.parent?.get(name);
    if (!inherited) return undefined;
    const shadow = this.toolsByName.get(inherited.name);
    if (shadow) return this.isVisible(shadow) ? shadow : undefined;
    return this.isVisible(inherited) ? inherited : undefined;
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  list(): PilotDeckToolDefinition[] {
    return this.listAll().filter((tool) => !this.hidden.has(tool.name));
  }

  /** Includes deferred tools so host setup can validate and reveal them. */
  listAll(): PilotDeckToolDefinition[] {
    if (this.registryState !== "active") return [];
    const visible = new Map<string, PilotDeckToolDefinition>();
    for (const tool of this.parent?.listAll() ?? []) {
      if (this.isVisible(tool)) visible.set(tool.name, tool);
    }
    for (const tool of this.toolsByName.values()) {
      if (this.isVisible(tool)) visible.set(tool.name, tool);
      else visible.delete(tool.name);
    }
    return [...visible.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  hide(name: string): boolean {
    const tool = this.get(name);
    if (!tool) return false;
    this.hidden.add(tool.name);
    return true;
  }

  reveal(name: string): boolean {
    const realName = this.aliases.get(name) ?? name;
    return this.hidden.delete(realName);
  }

  isHidden(name: string): boolean {
    const realName = this.aliases.get(name) ?? name;
    return this.hidden.has(realName);
  }

  markUnavailable(diagnostic: ToolUnavailableDiagnostic, aliases: readonly string[] = []): void {
    this.assertActive("mark a tool unavailable");
    this.unavailable.set(diagnostic.toolName, diagnostic);
    for (const alias of aliases) {
      this.unavailable.set(alias, diagnostic);
    }
  }

  getUnavailable(name: string): ToolUnavailableDiagnostic | undefined {
    if (this.registryState !== "active") return undefined;
    const realName = this.aliases.get(name) ?? name;
    return this.unavailable.get(realName)
      ?? this.unavailable.get(name)
      ?? this.parent?.getUnavailable(name);
  }

  listUnavailable(): ToolUnavailableDiagnostic[] {
    return this.listUnavailableEntries().map(({ diagnostic }) => diagnostic);
  }

  listUnavailableEntries(): ToolUnavailableDiagnosticEntry[] {
    if (this.registryState !== "active") return [];
    const entries = new Map<string, ToolUnavailableDiagnosticEntry>();
    for (const entry of this.parent?.listUnavailableEntries() ?? []) {
      entries.set(entry.diagnostic.toolName, {
        diagnostic: entry.diagnostic,
        aliases: [...entry.aliases],
      });
    }
    for (const [name, diagnostic] of this.unavailable) {
      let entry = entries.get(diagnostic.toolName);
      if (!entry) {
        entry = { diagnostic, aliases: [] };
        entries.set(diagnostic.toolName, entry);
      }
      if (name !== diagnostic.toolName && !entry.aliases.includes(name)) {
        entry.aliases.push(name);
      }
    }
    return [...entries.values()]
      .map((entry) => ({ ...entry, aliases: [...entry.aliases].sort() }))
      .sort((a, b) => a.diagnostic.toolName.localeCompare(b.diagnostic.toolName));
  }

  toCanonicalSchemas(): CanonicalToolSchema[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  /**
   * Shallow-clone this registry so the caller can register additional tools
   * (or replace existing ones) without mutating the original.  Tool
   * definitions are shared by reference — only the lookup maps are copied.
   */
  clone(): ToolRegistry {
    this.assertActive("clone a tool registry");
    const copy = new ToolRegistry();
    for (const tool of this.list()) {
      copy.register(tool);
    }
    for (const { diagnostic, aliases } of this.listUnavailableEntries()) {
      copy.markUnavailable(diagnostic, aliases);
    }
    for (const name of this.hidden) {
      copy.hidden.add(name);
    }
    return copy;
  }

  createScopedView(policy: ToolCapabilityPolicy): ToolRegistry {
    this.assertActive("create a scoped tool view");
    return new ToolRegistry({ parent: this, policy });
  }

  /**
   * Remove a tool (and its aliases) from the registry.
   * Returns true if the tool was found and removed, false otherwise.
   */
  unregister(name: string): boolean {
    this.assertActive("unregister a tool");
    const tool = this.toolsByName.get(name);
    if (!tool) return false;
    this.removeLocalTool(tool);
    return true;
  }

  /**
   * Replace an existing tool definition in-place.  Unlike `register()`,
   * this overwrites the entry keyed by `tool.name` (which must already
   * exist).  Aliases from the *previous* definition are removed and
   * replaced with those from the new one.
   */
  replace(tool: PilotDeckToolDefinition): ToolRegistration {
    this.assertActive("replace a tool");
    const existing = this.toolsByName.get(tool.name);
    if (!existing) {
      throw new Error(`Tool ${tool.name} is not registered — cannot replace.`);
    }
    this.removeLocalTool(existing);
    this.toolsByName.set(tool.name, tool);
    this.unavailable.delete(tool.name);
    for (const alias of tool.aliases ?? []) {
      this.aliases.set(alias, tool.name);
    }
    let registration: ToolRegistrationImpl;
    registration = new ToolRegistrationImpl(tool.name, () => {
      if (this.toolsByName.get(tool.name) !== tool) return;
      this.removeLocalTool(tool);
    });
    this.registrations.set(tool.name, registration);
    return registration;
  }

  /**
   * Register a local definition or replace the existing local definition.
   * An inherited definition is shadowed without mutating the parent registry.
   */
  registerOrReplace(tool: PilotDeckToolDefinition): ToolRegistration {
    return this.toolsByName.has(tool.name)
      ? this.replace(tool)
      : this.register(tool);
  }

  /** Dispose local registrations without affecting a parent registry. */
  dispose(): void {
    if (this.registryState === "disposed") return;
    this.registryState = "disposed";
    for (const registration of this.registrations.values()) registration.deactivate();
    this.registrations.clear();
    this.toolsByName.clear();
    this.aliases.clear();
    this.unavailable.clear();
  }

  private isVisible(tool: PilotDeckToolDefinition): boolean {
    return this.policy?.evaluate(tool).allowed ?? true;
  }

  private removeLocalTool(tool: PilotDeckToolDefinition, deactivate = true): void {
    for (const alias of tool.aliases ?? []) {
      this.aliases.delete(alias);
      this.unavailable.delete(alias);
    }
    this.toolsByName.delete(tool.name);
    this.unavailable.delete(tool.name);
    const registration = this.registrations.get(tool.name);
    this.registrations.delete(tool.name);
    if (deactivate) registration?.deactivate();
  }

  private assertActive(action: string): void {
    if (this.registryState !== "active") {
      throw new Error(`Cannot ${action}; tool registry is disposed.`);
    }
  }
}

class ToolRegistrationImpl implements ToolRegistration {
  private activeState = true;

  constructor(
    readonly name: string,
    private readonly remove: () => void,
  ) {}

  get active(): boolean {
    return this.activeState;
  }

  dispose(): void {
    if (!this.activeState) return;
    this.activeState = false;
    this.remove();
  }

  deactivate(): void {
    this.activeState = false;
  }
}
