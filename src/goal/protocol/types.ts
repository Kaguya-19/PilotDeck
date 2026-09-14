export type GoalPhase = "active" | "paused" | "blocked" | "complete";

export type GoalSnapshot = {
  id: string;
  revision: number;
  objective: string;
  phase: GoalPhase;
  blockedReason?: string;
  maxGoalRounds?: number;
};

export type GoalStateSnapshot = {
  goal: GoalSnapshot | null;
  revision: number;
};

export type GoalUpdate = {
  expectedRevision?: number;
  action?: "edit" | "pause" | "resume" | "complete" | "block" | "clear";
  objective?: string;
  blockedReason?: string;
  maxGoalRounds?: number;
};

export type GoalSessionPort = {
  getSnapshot(): GoalStateSnapshot;
  create(objective: string, options?: { maxGoalRounds?: number; id?: string; turnId?: string }): Promise<GoalSnapshot>;
  update(update: GoalUpdate & { turnId: string }): Promise<GoalSnapshot | null>;
};

export type GoalPort = {
  forSession(sessionId: string): GoalSessionPort;
};
