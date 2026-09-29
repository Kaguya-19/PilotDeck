import { requireSessionProjectionValue } from "../../session/projection/SessionProjection.js";
import type { SessionProjectionDriver } from "../../session/projection/SessionProjectionDriver.js";
import type { AgentTranscriptWriter } from "../../session/transcript/TranscriptWriter.js";
import { GoalConflictError } from "../protocol/errors.js";
import { GOAL_PROJECTION_NAME } from "../projection/GoalProjection.js";
import type { GoalPort, GoalSessionPort, GoalSnapshot, GoalStateSnapshot, GoalUpdate } from "../protocol/types.js";

export type NativeGoalRuntimeOptions = {
  sessionId: string;
  transcript: AgentTranscriptWriter;
  projections: SessionProjectionDriver;
  uuid?: () => string;
};

export class NativeGoalRuntime implements GoalPort {
  private readonly handle: GoalSessionPort;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: NativeGoalRuntimeOptions) {
    this.handle = {
      getSnapshot: () => this.snapshot(),
      create: (objective, createOptions) => this.enqueue(() => this.create(objective, createOptions)),
      update: (update) => this.enqueue(() => this.update(update)),
    };
  }

  forSession(sessionId: string): GoalSessionPort {
    if (sessionId !== this.options.sessionId) {
      throw new Error(`Goal runtime belongs to ${this.options.sessionId}, not ${sessionId}.`);
    }
    return this.handle;
  }

  private snapshot(): GoalStateSnapshot {
    return requireSessionProjectionValue<GoalStateSnapshot>(
      this.options.projections.snapshot([GOAL_PROJECTION_NAME]),
      GOAL_PROJECTION_NAME,
    );
  }

  private async create(objective: string, createOptions: { maxGoalRounds?: number; id?: string; turnId?: string } = {}): Promise<GoalSnapshot> {
    const current = this.snapshot();
    if (current.goal) throw new GoalConflictError("A goal already exists; update or clear it before creating another.", undefined, current.revision);
    const normalizedObjective = objective.trim();
    if (!normalizedObjective) throw new Error("Goal objective must not be empty.");
    const maxGoalRounds = createOptions.maxGoalRounds;
    if (maxGoalRounds !== undefined && (!Number.isSafeInteger(maxGoalRounds) || maxGoalRounds < 1)) {
      throw new Error("maxGoalRounds must be a positive integer.");
    }
    const revision = current.revision + 1;
    const goal: GoalSnapshot = {
      id: createOptions.id?.trim() || `goal-${this.options.uuid?.() ?? revision}`,
      revision,
      objective: normalizedObjective,
      phase: "active",
      ...(maxGoalRounds !== undefined ? { maxGoalRounds } : {}),
    };
    await this.append(goal, createOptions.turnId ?? "goal");
    return goal;
  }

  private async update(update: GoalUpdate & { turnId: string }): Promise<GoalSnapshot | null> {
    const current = this.snapshot();
    if (update.expectedRevision !== undefined && update.expectedRevision !== current.revision) {
      throw new GoalConflictError(
        `Goal revision conflict: expected ${update.expectedRevision}, current is ${current.revision}.`,
        update.expectedRevision,
        current.revision,
      );
    }
    if (!current.goal) {
      if (update.action === "clear") return null;
      throw new Error("No goal exists for this session.");
    }
    if (update.action === "clear") {
      await this.append(null, update.turnId);
      return null;
    }
    const action = update.action ?? "edit";
    const objective = update.objective?.trim() || current.goal.objective;
    if (!objective) throw new Error("Goal objective must not be empty.");
    const phase = action === "pause" ? "paused"
      : action === "resume" ? "active"
        : action === "complete" ? "complete"
          : action === "block" ? "blocked"
            : current.goal.phase;
    const maxGoalRounds = update.maxGoalRounds ?? current.goal.maxGoalRounds;
    if (maxGoalRounds !== undefined && (!Number.isSafeInteger(maxGoalRounds) || maxGoalRounds < 1)) {
      throw new Error("maxGoalRounds must be a positive integer.");
    }
    const goal: GoalSnapshot = {
      ...current.goal,
      revision: current.revision + 1,
      objective,
      phase,
      ...(phase === "blocked" && update.blockedReason?.trim() ? { blockedReason: update.blockedReason.trim() } : {}),
      ...(phase !== "blocked" ? {} : current.goal.blockedReason && !update.blockedReason ? { blockedReason: current.goal.blockedReason } : {}),
      ...(maxGoalRounds !== undefined ? { maxGoalRounds } : {}),
    };
    if (phase !== "blocked") delete goal.blockedReason;
    await this.append(goal, update.turnId);
    return goal;
  }

  private async append(goal: GoalSnapshot | null, turnId: string): Promise<void> {
    const revision = this.snapshot().revision + 1;
    await this.options.transcript.recordSessionEvent(this.options.sessionId, turnId, {
      type: "goal_changed",
      goal,
      revision,
    });
  }

  private enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const run = this.mutationTail.then(operation, operation);
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }
}

export function createNativeGoalRuntime(options: NativeGoalRuntimeOptions): NativeGoalRuntime {
  return new NativeGoalRuntime(options);
}
