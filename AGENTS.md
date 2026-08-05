# PilotDeck Development Rules

These rules apply to human contributors and coding agents working in this repository.

## Architecture Invariants

- The Gateway is the source of truth for sessions, turns, messages, and active-run state.
- The UI Server bridge translates Gateway events; it must not create a second agent state machine.
- A session may have at most one active turn. Preserve `sessionKey`, `turnId`, `runId`, and `toolCallId` across process boundaries.
- Every accepted tool call must terminate with exactly one success, failure, timeout, or cancellation result.
- Router decisions must not mutate the accepted user message or previously persisted conversation history.

## Change Discipline

- Reproduce a bug on current `main` before fixing it, and add a regression test that fails for the original behavior.
- Fix the complete bug class, including sibling call paths, while keeping the change scoped to the reported behavior.
- Add or update contract tests whenever Gateway RPCs or streamed event fields change.
- Do not delete, skip, or weaken a failing test to make a change pass. Do not include unrelated refactors.
- Use Node.js 22 and the committed pnpm lockfile. Run `pnpm check` before handing off a change.

See `docs/quality-gates.md` for the local and CI quality-gate workflow.
