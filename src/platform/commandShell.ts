export function resolveCommandShell(env?: NodeJS.ProcessEnv): boolean | string {
  if (process.platform !== "win32") {
    return true;
  }

  const bundledBash = env?.PILOTDECK_BASH_PATH?.trim();
  return bundledBash || true;
}
