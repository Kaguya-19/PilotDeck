import { randomUUID } from "node:crypto";
import {
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getPilotProjectChatDir } from "../../pilot/index.js";
import { sanitizeSessionIdForPath } from "../storage/ProjectSessionStorage.js";
import type {
  ProjectSessionReplacementFinalizeInput,
  ProjectSessionReplacementOwner,
  ProjectSessionReplacementPort,
  ProjectSessionReplacementPrepareInput,
  ProjectSessionReplacementRecoveryResult,
} from "./ProjectSessionReplacementPort.js";

type ReplacementJournal = {
  version: 1 | 2;
  transactionId: string;
  sessionKey: string;
  replacementTurnId: string;
  preparedAt: string;
  owner?: ProjectSessionReplacementOwner;
};

export type RecoverNodeProjectSessionReplacementsResult = {
  committed: number;
  rolledBack: number;
  cleaned: number;
  skipped: number;
  failures: Array<{ transcriptPath: string; message: string }>;
};

export type RecoverNodeProjectSessionReplacementsOptions = {
  /** @internal Injectable process probe for deterministic recovery tests. */
  isProcessAlive?: (pid: number) => boolean;
};

export class NodeProjectSessionReplacementError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "NodeProjectSessionReplacementError";
  }
}

function replacementPaths(
  sessionKey: string,
  projectKey: string,
  pilotHome: string,
  transactionId?: string,
): { transcriptPath: string; safeId: string; backupPath?: string; journalPath?: string } {
  const chatDir = getPilotProjectChatDir(projectKey, pilotHome);
  const safeId = sanitizeSessionIdForPath(sessionKey);
  const transcriptPath = resolve(chatDir, `${safeId}.jsonl`);
  return {
    transcriptPath,
    safeId,
    ...(transactionId
      ? {
          backupPath: resolve(chatDir, `.${safeId}.${transactionId}.replace.bak`),
          journalPath: resolve(chatDir, `.${safeId}.${transactionId}.replace.json`),
        }
      : {}),
  };
}

function validateTransactionId(transactionId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(transactionId)) {
    throw new NodeProjectSessionReplacementError("replace_invalid_transaction", "The replacement transaction is invalid.");
  }
}

function isTransactionId(transactionId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(transactionId);
}

function readReplacementJournalSync(
  journalPath: string,
  transactionId: string,
): ReplacementJournal | undefined {
  try {
    const parsed = JSON.parse(readFileSync(journalPath, "utf8")) as Partial<ReplacementJournal>;
    if (
      (parsed.version !== 1 && parsed.version !== 2)
      || parsed.transactionId !== transactionId
      || typeof parsed.sessionKey !== "string"
      || !parsed.sessionKey.trim()
      || typeof parsed.replacementTurnId !== "string"
      || !parsed.replacementTurnId.trim()
      || typeof parsed.preparedAt !== "string"
    ) {
      return undefined;
    }
    if (
      parsed.version === 2
      && (
        typeof parsed.owner !== "object"
        || parsed.owner === null
        || typeof parsed.owner.instanceId !== "string"
        || !parsed.owner.instanceId.trim()
        || !Number.isSafeInteger(parsed.owner.pid)
        || parsed.owner.pid <= 0
      )
    ) {
      return undefined;
    }
    return parsed as ReplacementJournal;
  } catch {
    return undefined;
  }
}

function acceptedTurnIds(body: string): Set<string> {
  const turnIds = new Set<string>();
  for (const line of body.split(/\r?\n/)) {
    if (!line.includes('"type":"accepted_input"') || !line.includes('"turnId"')) continue;
    try {
      const entry = JSON.parse(line) as { type?: unknown; turnId?: unknown };
      if (entry.type === "accepted_input" && typeof entry.turnId === "string") {
        turnIds.add(entry.turnId);
      }
    } catch {
      // Malformed lines do not provide durable commit evidence.
    }
  }
  return turnIds;
}

function readAcceptedTurnIdsSync(transcriptPath: string): Set<string> {
  try {
    return acceptedTurnIds(readFileSync(transcriptPath, "utf8"));
  } catch {
    return new Set();
  }
}

type ReplacementArtifact = {
  safeId: string;
  transactionId: string;
  backupPath: string;
  journalPath: string;
};

type ReplacementArtifactState = {
  artifact: ReplacementArtifact;
  journal?: ReplacementJournal;
  order: number;
  hasBackup: boolean;
};

function artifactMtimeMs(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

function replacementArtifactState(artifact: ReplacementArtifact): ReplacementArtifactState {
  const journal = readReplacementJournalSync(artifact.journalPath, artifact.transactionId);
  const preparedAt = journal ? Date.parse(journal.preparedAt) : Number.NaN;
  const backupMtime = artifactMtimeMs(artifact.backupPath);
  const journalMtime = artifactMtimeMs(artifact.journalPath);
  return {
    artifact,
    journal,
    order: Math.max(
      Number.isFinite(preparedAt) ? preparedAt : 0,
      backupMtime ?? 0,
      journalMtime ?? 0,
    ),
    hasBackup: backupMtime !== undefined,
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "EPERM"
    );
  }
}

/** Recover Node JSONL replacement journals before a local Gateway starts. */
export function recoverNodeProjectSessionReplacements(
  pilotHome: string,
  options: RecoverNodeProjectSessionReplacementsOptions = {},
): RecoverNodeProjectSessionReplacementsResult {
  const result: RecoverNodeProjectSessionReplacementsResult = {
    committed: 0,
    rolledBack: 0,
    cleaned: 0,
    skipped: 0,
    failures: [],
  };
  const processIsAlive = options.isProcessAlive ?? isProcessAlive;
  const groups = new Map<string, { transcriptPath: string; artifacts: ReplacementArtifact[] }>();
  const projectsDir = resolve(pilotHome, "projects");
  let projectDirNames: string[];
  try {
    projectDirNames = readdirSync(projectsDir, { withFileTypes: true, encoding: "utf8" })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return result;
  }

  for (const projectDirName of projectDirNames) {
    const chatDir = resolve(projectsDir, projectDirName, "chats");
    let names: string[];
    try {
      names = readdirSync(chatDir);
    } catch {
      continue;
    }
    for (const name of names) {
      const match = /^\.(.+)\.([0-9a-f-]{36})\.replace\.(?:bak|json)$/i.exec(name);
      if (!match || !isTransactionId(match[2])) continue;
      const [, safeId, transactionId] = match;
      const key = resolve(chatDir, safeId);
      const group = groups.get(key) ?? {
        transcriptPath: resolve(chatDir, `${safeId}.jsonl`),
        artifacts: [],
      };
      if (!group.artifacts.some((artifact) => artifact.transactionId === transactionId)) {
        group.artifacts.push({
          safeId,
          transactionId,
          backupPath: resolve(chatDir, `.${safeId}.${transactionId}.replace.bak`),
          journalPath: resolve(chatDir, `.${safeId}.${transactionId}.replace.json`),
        });
      }
      groups.set(key, group);
    }
  }

  for (const group of groups.values()) {
    try {
      const states = group.artifacts
        .map(replacementArtifactState)
        .sort((left, right) => right.order - left.order);
      const latest = states[0];
      if (!latest) continue;

      const owner = latest.journal?.owner;
      if (owner && processIsAlive(owner.pid)) {
        result.skipped += 1;
        continue;
      }

      const currentAcceptedTurnIds = readAcceptedTurnIdsSync(group.transcriptPath);
      let committed: boolean;
      if (latest.journal) {
        committed = currentAcceptedTurnIds.has(latest.journal.replacementTurnId);
      } else {
        try {
          const originalTurnIds = acceptedTurnIds(readFileSync(latest.artifact.backupPath, "utf8"));
          committed = [...currentAcceptedTurnIds].some((turnId) => !originalTurnIds.has(turnId));
        } catch {
          committed = false;
        }
      }
      if (committed) {
        for (const artifact of group.artifacts) {
          rmSync(artifact.backupPath, { force: true });
          rmSync(artifact.journalPath, { force: true });
        }
        result.committed += 1;
        result.cleaned += group.artifacts.length;
        continue;
      }

      if (!latest.hasBackup) {
        throw new Error(`Newest replacement transaction ${latest.artifact.transactionId} has no backup to restore.`);
      }

      const originalBody = readFileSync(latest.artifact.backupPath, "utf8");
      const temporaryPath = resolve(
        dirname(group.transcriptPath),
        `.${latest.artifact.safeId}.${randomUUID()}.recovery.tmp`,
      );
      try {
        writeFileSync(temporaryPath, originalBody, { encoding: "utf8", mode: 0o600 });
        renameSync(temporaryPath, group.transcriptPath);
      } finally {
        rmSync(temporaryPath, { force: true });
      }
      for (const artifact of group.artifacts) {
        rmSync(artifact.backupPath, { force: true });
        rmSync(artifact.journalPath, { force: true });
      }
      result.rolledBack += 1;
      result.cleaned += group.artifacts.length;
    } catch (error) {
      result.failures.push({
        transcriptPath: group.transcriptPath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

async function prepareNodeProjectSessionReplacement(
  input: ProjectSessionReplacementPrepareInput,
): Promise<void> {
  validateTransactionId(input.transactionId);
  const { transcriptPath, safeId, backupPath, journalPath } = replacementPaths(
    input.sessionId,
    input.projectRoot,
    input.pilotHome,
    input.transactionId,
  );
  if (!backupPath || !journalPath) throw new Error("Replacement transaction paths were not created.");
  const originalBody = await readFile(transcriptPath, "utf8");
  const body = input.replacementEntries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
  const temporaryPath = resolve(dirname(transcriptPath), `.${safeId}.${randomUUID()}.replace.tmp`);
  try {
    const journal: ReplacementJournal = {
      version: input.owner ? 2 : 1,
      transactionId: input.transactionId,
      sessionKey: input.sessionId,
      replacementTurnId: input.replacementTurnId,
      preparedAt: input.preparedAt,
      ...(input.owner ? { owner: input.owner } : {}),
    };
    await writeFile(journalPath, `${JSON.stringify(journal)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await writeFile(backupPath, originalBody, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await writeFile(temporaryPath, body, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, transcriptPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    await rm(backupPath, { force: true }).catch(() => undefined);
    await rm(journalPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function finalizeNodeProjectSessionReplacement(
  input: ProjectSessionReplacementFinalizeInput,
): Promise<void> {
  validateTransactionId(input.transactionId);
  const { transcriptPath, safeId, backupPath, journalPath } = replacementPaths(
    input.sessionId,
    input.projectRoot,
    input.pilotHome,
    input.transactionId,
  );
  if (!backupPath || !journalPath) throw new Error("Replacement transaction paths were not created.");

  if (input.action === "commit") {
    await rm(backupPath, { force: true });
    await rm(journalPath, { force: true });
    return;
  }

  let originalBody: string;
  try {
    originalBody = await readFile(backupPath, "utf8");
  } catch (error) {
    throw new NodeProjectSessionReplacementError(
      "replace_transaction_missing",
      `The replacement transaction could not be restored: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const temporaryPath = resolve(dirname(transcriptPath), `.${safeId}.${randomUUID()}.rollback.tmp`);
  try {
    await writeFile(temporaryPath, originalBody, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, transcriptPath);
    await rm(backupPath, { force: true });
    await rm(journalPath, { force: true });
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Native JSONL prepared-replacement provider. */
export const nodeProjectSessionReplacementPort: ProjectSessionReplacementPort = Object.freeze({
  prepare: prepareNodeProjectSessionReplacement,
  finalize: finalizeNodeProjectSessionReplacement,
  recover(input): ProjectSessionReplacementRecoveryResult {
    const result = recoverNodeProjectSessionReplacements(input.pilotHome);
    return {
      ...result,
      failures: result.failures.map((failure) => ({ scope: failure.transcriptPath, message: failure.message })),
    };
  },
});
