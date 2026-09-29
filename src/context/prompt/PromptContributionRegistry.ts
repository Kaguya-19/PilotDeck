import type { CanonicalToolSchema } from "../../model/index.js";
import type { ToolRegistry } from "../../tool/index.js";

export type PromptContributionContext = Readonly<{
  sessionId: string;
  turnId: string;
  cwd: string;
  provider: string;
  model: string;
  permissionMode: string;
  runMode?: string;
  additionalWorkingDirectories: readonly string[];
  abortSignal?: AbortSignal;
}>;

export type PromptTextProvider =
  | string
  | ((context: PromptContributionContext) => string | Promise<string>);

export type PromptSectionContribution = {
  name: string;
  order: number;
  text: PromptTextProvider;
  complete?: boolean;
};

export type PromptRuntimeContextContribution = {
  name: string;
  order: number;
  text: PromptTextProvider;
};

export type PromptVariableProvider = (
  context: PromptContributionContext,
) => string | undefined | Promise<string | undefined>;

export type PromptContributionRegistrationKind = "section" | "runtime_context" | "variable";

export type PromptContributionRegistration = {
  readonly kind: PromptContributionRegistrationKind;
  readonly name: string;
  readonly generation: number;
  readonly active: boolean;
  dispose(): void;
};

export type AssembledPromptSection = {
  readonly name: string;
  readonly order: number;
  readonly text: string;
  readonly complete: boolean;
};

export type AssembledPromptRuntimeContext = {
  readonly name: string;
  readonly order: number;
  readonly text: string;
};

export type PromptToolSchemaSource = {
  snapshot(): readonly CanonicalToolSchema[];
};

export type PromptContributionSnapshotOptions = {
  toolSchemas?: PromptToolSchemaSource;
  variables?: Readonly<Record<string, string | undefined>>;
};

export type PromptContributionSnapshot = {
  readonly generation: number;
  readonly sections: readonly AssembledPromptSection[];
  readonly runtimeContexts: readonly AssembledPromptRuntimeContext[];
  readonly variables: Readonly<Record<string, string | undefined>>;
  readonly tools: readonly CanonicalToolSchema[];
};

export type PromptContributionRegistryOptions = {
  name?: string;
};

export type PromptContributionRegistryState = "active" | "disposed";
type RegistryClock = { value: number };

type RegisteredContribution<Value> = {
  value: Value;
  registration: PromptContributionRegistrationImpl;
};

const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/;

export class PromptContributionRegistry {
  readonly name: string;

  private readonly sections = new Map<string, RegisteredContribution<PromptSectionContribution>>();
  private readonly runtimeContexts = new Map<string, RegisteredContribution<PromptRuntimeContextContribution>>();
  private readonly variables = new Map<string, RegisteredContribution<PromptVariableProvider>>();
  private readonly children = new Set<PromptContributionRegistry>();
  private clock: RegistryClock = { value: 0 };
  private parent?: PromptContributionRegistry;
  private registryState: PromptContributionRegistryState = "active";

  constructor(options: PromptContributionRegistryOptions = {}) {
    this.name = options.name?.trim() || "prompt-contributions";
  }

  get state(): PromptContributionRegistryState {
    return this.registryState;
  }

  get generation(): number {
    return this.clock.value;
  }

  createChild(options: PromptContributionRegistryOptions = {}): PromptContributionRegistry {
    this.assertActive("create a child registry");
    const child = new PromptContributionRegistry(options);
    child.clock = this.clock;
    child.parent = this;
    this.children.add(child);
    return child;
  }

  registerSection(contribution: PromptSectionContribution): PromptContributionRegistration {
    const name = validateName(contribution.name, "prompt section");
    validateOrder(contribution.order, `prompt section "${name}"`);
    return this.register(
      this.sections,
      "section",
      name,
      Object.freeze({ ...contribution, name, complete: contribution.complete === true }),
    );
  }

  registerRuntimeContext(
    contribution: PromptRuntimeContextContribution,
  ): PromptContributionRegistration {
    const name = validateName(contribution.name, "prompt runtime context");
    validateOrder(contribution.order, `prompt runtime context "${name}"`);
    return this.register(
      this.runtimeContexts,
      "runtime_context",
      name,
      Object.freeze({ ...contribution, name }),
    );
  }

  registerVariable(name: string, provider: PromptVariableProvider): PromptContributionRegistration {
    const normalized = validateName(name, "prompt variable");
    if (!VARIABLE_NAME.test(normalized)) {
      throw new Error(`invalid prompt variable name "${normalized}" (must match ${String(VARIABLE_NAME)})`);
    }
    return this.register(this.variables, "variable", normalized, provider);
  }

  async snapshot(
    context: PromptContributionContext,
    options: PromptContributionSnapshotOptions = {},
  ): Promise<PromptContributionSnapshot> {
    this.assertActive("capture a prompt contribution snapshot");
    context.abortSignal?.throwIfAborted();

    const generation = this.clock.value;
    const snapshotContext = captureContext(context);
    const sections = [...this.collectSections().values()].map((entry) => entry.value);
    const runtimeContexts = [...this.collectRuntimeContexts().values()].map((entry) => entry.value);
    const variables = [...this.collectVariables().entries()].map(([name, entry]) => ({
      name,
      provider: entry.value,
    }));
    const tools = captureToolSchemas(options.toolSchemas);

    sections.sort(compareOrderedContributions);
    runtimeContexts.sort(compareOrderedContributions);
    variables.sort((left, right) => compareNames(left.name, right.name));
    const completeSectionNames = sections
      .filter((section) => section.complete === true)
      .map((section) => section.name);
    if (completeSectionNames.length > 1) {
      throw new Error(`Multiple complete prompt sections are visible: ${completeSectionNames.join(", ")}`);
    }

    const assembledSections: AssembledPromptSection[] = [];
    for (const section of sections) {
      assembledSections.push(Object.freeze({
        name: section.name,
        order: section.order,
        text: await resolveText(section.text, snapshotContext, `prompt section "${section.name}"`),
        complete: section.complete === true,
      }));
    }

    const assembledRuntimeContexts: AssembledPromptRuntimeContext[] = [];
    for (const contribution of runtimeContexts) {
      assembledRuntimeContexts.push(Object.freeze({
        name: contribution.name,
        order: contribution.order,
        text: await resolveText(
          contribution.text,
          snapshotContext,
          `prompt runtime context "${contribution.name}"`,
        ),
      }));
    }

    const assembledVariables: Record<string, string | undefined> = {
      ...options.variables,
    };
    for (const variable of variables) {
      snapshotContext.abortSignal?.throwIfAborted();
      const value = await variable.provider(snapshotContext);
      snapshotContext.abortSignal?.throwIfAborted();
      if (value !== undefined && typeof value !== "string") {
        throw new TypeError(`prompt variable "${variable.name}" must resolve to a string or undefined`);
      }
      assembledVariables[variable.name] = value;
    }

    return Object.freeze({
      generation,
      sections: Object.freeze(assembledSections),
      runtimeContexts: Object.freeze(assembledRuntimeContexts),
      variables: Object.freeze(assembledVariables),
      tools: Object.freeze(tools),
    });
  }

  dispose(): void {
    if (this.registryState === "disposed") return;
    for (const child of [...this.children].reverse()) child.dispose();
    this.children.clear();
    for (const entry of this.sections.values()) entry.registration.deactivate();
    for (const entry of this.runtimeContexts.values()) entry.registration.deactivate();
    for (const entry of this.variables.values()) entry.registration.deactivate();
    this.sections.clear();
    this.runtimeContexts.clear();
    this.variables.clear();
    this.registryState = "disposed";
    this.parent?.children.delete(this);
    this.touch();
  }

  private register<Value>(
    entries: Map<string, RegisteredContribution<Value>>,
    kind: PromptContributionRegistrationKind,
    name: string,
    value: Value,
  ): PromptContributionRegistration {
    this.assertActive(`register ${kind} ${name}`);
    if (entries.has(name)) {
      throw new Error(`${kindLabel(kind)} "${name}" is already registered in ${this.name}`);
    }

    const generation = this.touch();
    let registration: PromptContributionRegistrationImpl;
    registration = new PromptContributionRegistrationImpl(kind, name, generation, () => {
      const current = entries.get(name);
      if (current?.registration !== registration) return;
      entries.delete(name);
      this.touch();
    });
    entries.set(name, { value, registration });
    return registration;
  }

  private collectSections(): Map<string, RegisteredContribution<PromptSectionContribution>> {
    return mergeNamed(this.parent?.collectSections(), this.sections);
  }

  private collectRuntimeContexts(): Map<string, RegisteredContribution<PromptRuntimeContextContribution>> {
    return mergeNamed(this.parent?.collectRuntimeContexts(), this.runtimeContexts);
  }

  private collectVariables(): Map<string, RegisteredContribution<PromptVariableProvider>> {
    return mergeNamed(this.parent?.collectVariables(), this.variables);
  }

  private assertActive(action: string): void {
    if (this.registryState !== "active") {
      throw new Error(`Cannot ${action}; prompt contribution registry ${this.name} is disposed.`);
    }
  }

  private touch(): number {
    this.clock.value += 1;
    return this.clock.value;
  }
}

export function renderPromptContributionSections(
  snapshot: PromptContributionSnapshot,
): string[] {
  const complete = snapshot.sections.find((section) => section.complete);
  const sections = complete ? [complete] : snapshot.sections;
  return sections
    .map((section) => interpolatePromptVariables(
      section.text,
      snapshot.variables,
      `prompt section "${section.name}"`,
    ))
    .filter((text) => text.length > 0);
}

export function renderPromptRuntimeContextSections(
  snapshot: PromptContributionSnapshot,
): AssembledPromptRuntimeContext[] {
  return snapshot.runtimeContexts.flatMap((context) => {
    const text = interpolatePromptVariables(
      context.text,
      snapshot.variables,
      `prompt runtime context "${context.name}"`,
    );
    return text.length > 0 ? [{ ...context, text }] : [];
  });
}

export function createToolRegistryPromptSchemaSource(
  registry: Pick<ToolRegistry, "toCanonicalSchemas">,
): PromptToolSchemaSource {
  return Object.freeze({
    snapshot: () => registry.toCanonicalSchemas().map(cloneToolSchema),
  });
}

class PromptContributionRegistrationImpl implements PromptContributionRegistration {
  private activeState = true;

  constructor(
    readonly kind: PromptContributionRegistrationKind,
    readonly name: string,
    readonly generation: number,
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

function mergeNamed<Value>(
  parent: Map<string, RegisteredContribution<Value>> | undefined,
  local: Map<string, RegisteredContribution<Value>>,
): Map<string, RegisteredContribution<Value>> {
  const merged = new Map(parent);
  for (const [name, entry] of local) merged.set(name, entry);
  return merged;
}

function validateName(name: string, label: string): string {
  const normalized = name.trim();
  if (normalized.length === 0) throw new Error(`${label} name must not be empty`);
  if (normalized !== name) throw new Error(`${label} name must not contain surrounding whitespace`);
  return normalized;
}

function validateOrder(order: number, label: string): void {
  if (!Number.isFinite(order)) throw new TypeError(`${label} order must be a finite number`);
}

function kindLabel(kind: PromptContributionRegistrationKind): string {
  switch (kind) {
    case "section":
      return "prompt section";
    case "runtime_context":
      return "prompt runtime context";
    case "variable":
      return "prompt variable";
  }
}

function compareOrderedContributions(
  left: { order: number; name: string },
  right: { order: number; name: string },
): number {
  return left.order - right.order || compareNames(left.name, right.name);
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const VARIABLE_REFERENCE = /^\{\{([^{}]*)\}\}/;

function interpolatePromptVariables(
  text: string,
  variables: Readonly<Record<string, string | undefined>>,
  owner: string,
): string {
  let result = "";
  let last = 0;
  for (let open = text.indexOf("{{"); open >= 0; open = text.indexOf("{{", last)) {
    const group = VARIABLE_REFERENCE.exec(text.slice(open));
    if (!group) {
      if (text.indexOf("}}", open + 2) >= 0) {
        throw new Error(`malformed prompt variable reference in ${owner}`);
      }
      result += text.slice(last, open + 2);
      last = open + 2;
      continue;
    }
    const name = group[0].slice(2, -2);
    if (!VARIABLE_NAME.test(name)) {
      throw new Error(`malformed prompt variable reference "{{${name}}}" in ${owner}`);
    }
    if (!Object.hasOwn(variables, name)) {
      const known = Object.keys(variables);
      throw new Error(
        `unknown prompt variable "{{${name}}}" in ${owner}; registered variables: ${known.join(", ") || "(none)"}`,
      );
    }
    const value = variables[name];
    if (value === undefined) {
      throw new Error(`prompt variable "{{${name}}}" has no value in ${owner}`);
    }
    result += text.slice(last, open) + value;
    last = open + group[0].length;
  }
  return result + text.slice(last);
}

async function resolveText(
  provider: PromptTextProvider,
  context: PromptContributionContext,
  label: string,
): Promise<string> {
  context.abortSignal?.throwIfAborted();
  const value = typeof provider === "function" ? await provider(context) : provider;
  context.abortSignal?.throwIfAborted();
  if (typeof value !== "string") throw new TypeError(`${label} must resolve to a string`);
  return value;
}

function captureToolSchemas(source: PromptToolSchemaSource | undefined): CanonicalToolSchema[] {
  if (!source) return [];
  const schemas = source.snapshot().map(cloneToolSchema);
  schemas.sort((left, right) => compareNames(left.name, right.name));
  const names = new Set<string>();
  for (const schema of schemas) {
    if (schema.name.trim().length === 0) throw new Error("Prompt tool schema name must not be empty");
    if (names.has(schema.name)) throw new Error(`Prompt tool schema "${schema.name}" is duplicated`);
    names.add(schema.name);
  }
  return schemas.map((schema) => Object.freeze(schema));
}

function cloneToolSchema(schema: CanonicalToolSchema): CanonicalToolSchema {
  return {
    name: schema.name,
    ...(schema.description !== undefined ? { description: schema.description } : {}),
    inputSchema: structuredClone(schema.inputSchema),
  };
}

function captureContext(context: PromptContributionContext): PromptContributionContext {
  return Object.freeze({
    sessionId: context.sessionId,
    turnId: context.turnId,
    cwd: context.cwd,
    provider: context.provider,
    model: context.model,
    permissionMode: context.permissionMode,
    ...(context.runMode !== undefined ? { runMode: context.runMode } : {}),
    additionalWorkingDirectories: Object.freeze([...context.additionalWorkingDirectories]),
    ...(context.abortSignal !== undefined ? { abortSignal: context.abortSignal } : {}),
  });
}
