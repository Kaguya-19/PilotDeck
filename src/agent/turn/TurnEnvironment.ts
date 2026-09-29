import path from "node:path";

/** Build the process environment visible to one exact agent turn. */
export function buildTurnEnvironment(
  baseEnv: NodeJS.ProcessEnv | undefined,
  cwd: string,
  sessionId: string,
  turnId: string,
): NodeJS.ProcessEnv {
  return {
    ...(baseEnv ?? process.env),
    PILOTDECK_SESSION_ID: sessionId,
    PILOTDECK_TURN_ID: turnId,
    PILOTDECK_WORK_DIR: path.join(
      path.resolve(cwd),
      ".pilotdeck",
      "work",
      safeWorkPathSegment(sessionId),
      safeWorkPathSegment(turnId),
    ),
  };
}

function safeWorkPathSegment(value: string): string {
  const normalized = value.normalize("NFKC").replace(/[^a-zA-Z0-9._-]+/g, "-");
  return normalized.replace(/^[-.]+|[-.]+$/g, "").slice(0, 96) || "unknown";
}
