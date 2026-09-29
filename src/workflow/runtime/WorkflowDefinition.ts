import type { WorkflowDefinition as WorkflowDefinitionValue } from "../protocol/types.js";

export class InvalidWorkflowDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWorkflowDefinitionError";
  }
}

export function validateWorkflowDefinition(definition: WorkflowDefinitionValue): void {
  if (!definition.id || !definition.version) {
    throw new InvalidWorkflowDefinitionError("Workflow definition id and version are required.");
  }
  if (definition.steps.length === 0) {
    throw new InvalidWorkflowDefinitionError("Workflow definition must contain at least one step.");
  }
  const ids = new Set<string>();
  for (const step of definition.steps) {
    if (!step.id || ids.has(step.id)) {
      throw new InvalidWorkflowDefinitionError(`Workflow step id must be unique: ${step.id || "<empty>"}.`);
    }
    ids.add(step.id);
  }
  for (const step of definition.steps) {
    for (const dependency of step.dependsOn ?? []) {
      if (!ids.has(dependency)) {
        throw new InvalidWorkflowDefinitionError(`Workflow step ${step.id} depends on unknown step ${dependency}.`);
      }
      if (dependency === step.id) {
        throw new InvalidWorkflowDefinitionError(`Workflow step ${step.id} cannot depend on itself.`);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(definition.steps.map((step) => [step.id, step]));
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new InvalidWorkflowDefinitionError(`Workflow definition contains a cycle at ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const step of definition.steps) visit(step.id);
}

export function cloneWorkflowDefinition(definition: WorkflowDefinitionValue): WorkflowDefinitionValue {
  validateWorkflowDefinition(definition);
  return {
    id: definition.id,
    version: definition.version,
    steps: definition.steps.map((step) => ({
      id: step.id,
      ...(step.dependsOn?.length ? { dependsOn: [...step.dependsOn] } : {}),
      ...(step.capability ? { capability: step.capability } : {}),
    })),
  };
}
