import { existsSync } from "node:fs";
import { dirname, resolve, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRuntimeConfig } from "../agent/index.js";
import { resolvePilotHome } from "../pilot/index.js";

const DEFAULT_PERMISSION_TIMEOUT_MS = 120_000;
const DEFAULT_ELICITATION_TIMEOUT_MS = 120_000;

/** Inputs that select local application providers before any resource is acquired. */
export type LocalGatewayBootConfigInput = {
  projectRoot?: string;
  pilotHome?: string;
  builtinSkillsRoot?: string;
  env?: Record<string, string | undefined>;
  fallbackProjectRoot?: string;
  permissionMode?: AgentRuntimeConfig["permissionMode"];
  permissionTimeoutMs?: number;
  elicitationTimeoutMs?: number;
};

/** Immutable local application configuration after precedence has been resolved. */
export type LocalGatewayBootConfig = Readonly<{
  env: Record<string, string | undefined>;
  projectRoot: string;
  pilotHome: string;
  builtinSkillsRoot: string;
  fallbackProjectRoot: string;
  permissionMode: AgentRuntimeConfig["permissionMode"];
  permissionTimeoutMs: number;
  elicitationTimeoutMs: number;
}>;

/**
 * Resolve local boot provider selections once, before Gateway resources are
 * constructed. Explicit options retain their existing precedence over env;
 * this function does not mutate the caller's environment object.
 */
export function resolveLocalGatewayBootConfig(
  input: LocalGatewayBootConfigInput = {},
  cwd = process.cwd(),
): LocalGatewayBootConfig {
  const baseEnv = input.env ?? process.env;
  const projectRoot = resolve(input.projectRoot ?? cwd);
  const pilotHome = input.pilotHome ?? resolvePilotHome(baseEnv);
  const env = input.pilotHome ? { ...baseEnv, PILOT_HOME: pilotHome } : baseEnv;
  return Object.freeze({
    env,
    projectRoot,
    pilotHome,
    builtinSkillsRoot: resolveBuiltinSkillsRoot(input.builtinSkillsRoot, env, cwd),
    fallbackProjectRoot: input.fallbackProjectRoot ?? projectRoot,
    permissionMode: input.permissionMode ?? "default",
    permissionTimeoutMs: input.permissionTimeoutMs
      ?? readPositiveIntegerEnv(env.PILOTDECK_PERMISSION_TIMEOUT_MS)
      ?? DEFAULT_PERMISSION_TIMEOUT_MS,
    elicitationTimeoutMs: input.elicitationTimeoutMs
      ?? readPositiveIntegerEnv(env.PILOTDECK_ELICITATION_TIMEOUT_MS)
      ?? DEFAULT_ELICITATION_TIMEOUT_MS,
  });
}

export function readPositiveIntegerEnv(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function resolveBuiltinSkillsRoot(
  configuredRoot: string | undefined,
  env: Record<string, string | undefined>,
  cwd: string,
): string {
  const explicit = configuredRoot ?? env.PILOTDECK_BUNDLED_SKILLS_DIR;
  if (explicit) return resolve(explicit);

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    joinPath(moduleDir, "..", "..", "skills"),
    joinPath(moduleDir, "..", "..", "..", "skills"),
    joinPath(cwd, "skills"),
  ];
  return resolve(candidates.find((candidate) => existsSync(candidate)) ?? candidates[2]);
}
