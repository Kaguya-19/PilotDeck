export class GoalConflictError extends Error {
  constructor(
    message: string,
    readonly expectedRevision: number | undefined,
    readonly actualRevision: number,
  ) {
    super(message);
    this.name = "GoalConflictError";
  }
}
