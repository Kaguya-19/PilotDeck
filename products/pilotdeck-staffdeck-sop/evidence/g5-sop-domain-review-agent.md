# G5 SOP Domain Review

This evidence belongs to the isolated PilotDeck worktree created for the G5
domain task.

## Baseline

- Source: `PilotDeck-frontend-seven-slot`
- Branch: `codex/g5-sop-agent-pd`
- Commit: `9f66017139d017239929b304331bfba01992cb5a`
- Worktree: `/Users/a1/Desktop/claw/openbmb/PilotDeck-g5-sop-agent`
- PilotDeck accesses SOP management and runtime through host adapters and the
  explicit StaffDeck protocol; it does not import StaffDeck backend modules.

## Reviewed Contracts

- `ui/server/routes/sop.js` maps status/resume errors and never treats an
  unavailable Gateway as a successful reload.
- `ui/src/composition/modules/staffdeck/vendor/SkillsPage.tsx` and
  `DistillPage.tsx` consume the shared formal UI; host glue supplies the
  management client and capability state.
- `tests/sop/staffdeck-sop-agent-loop.spec.ts` and
  `tests/sop/staffdeck-sop-gateway-http-e2e.spec.ts` cover wait/resume,
  handoff/external-task continuation, stale revisions, duplicate request IDs,
  and terminal completion over the explicit Gateway boundary.

## Focused Verification

The intended rerun is:

```sh
cd /Users/a1/Desktop/claw/openbmb/PilotDeck-g5-sop-agent
env -u NODE_OPTIONS -u npm_config_node_options \
  PATH=/Users/a1/.nvm/versions/node/v22.22.0/bin:$PATH \
  pnpm exec vitest run tests/sop/staffdeck-sop-definitions.spec.ts \
    tests/sop/staffdeck-sop-agent-loop.spec.ts \
    tests/sop/staffdeck-sop-client.spec.ts
```

Result in this fresh worktree: **BLOCKED by environment**. The worktree has no
installed Node dependencies (`vitest` was not found). The command also avoids
the inherited invalid `NODE_OPTIONS` preload path.

No local YAML fallback was used as a management publish proof, and no runtime
state or database event was fabricated by this task.

## PilotDeck UI Publish Evidence

The PilotDeck runtime was restored through the onboarding flow and then
restarted with the SOP module binding active. The shared `/sop/distill` page
loaded the exact four-node/four-edge page-published graph. The page edit was
persisted as management draft `1.2.1`, the normal SOP action published it, and
the list returned the row as `1.2.1 / 已启用`.

The returned management object is preserved at
`evidence/g5-pilotdeck-page-published-1.2.1.json`. It contains nodes
`n1_collect`, `build_plan`, `confirm_scope`, and `finalize_plan`, with the
conditions `default`, `scope_changed`, `no_scope_change`, and
`confirmation_received`.

The exact-object reader and PilotDeck management adapter were corrected so a
page-published response can be loaded, edited into a management draft, and
listed with version rows. Focused verification passed:

```text
ui/server/routes/modules.test.js
ui/server/routes/onboarding.test.js
35 tests passed
```

The exact `1.2.1` object was replayed through the real SOP runtime with
`evidence/g5-real-run.mjs`. The replay preserved the handoff wait ID across
runtime reload, accepted the resume once, replayed the duplicate request, and
completed at terminal `finalize_plan` with `scope_confirmed=true`.

### Post-f91dfed9 Recheck

After `f91dfed9`, the real page path initially exposed a stale management draft
row: `replace_draft` returned `SOP_DRAFT_NOT_FOUND` after the prior draft had
been published. The adapter now falls back to `create` only for that explicit
404. On 2026-09-22, the page edit was saved in the UI, reloaded with the same
description and four-node/four-edge graph, and published with the normal
`启用` action as version `1.1.1`.

The returned object is preserved at
`evidence/g5-pilotdeck-postfix-page-published-1.1.1.json`; its replay output is
`/tmp/g5-ui-pilotdeck-postfix-1.1.1.json`. The replay kept wait ID
`98f134ba-c929-4055-ba1f-9ea687490f0b` across reload, accepted one resume,
replayed the duplicate, and completed at `finalize_plan` with
`scope_confirmed=true`.

### AgentLoop Runtime Recheck

The runtime adapter now accepts the exact page-published management response as
the configured `modules.sop.definitionsPath`; it normalizes that response at
the loader boundary without changing AgentLoop or StaffDeck lifecycle rules.
The exact-object deterministic replay is recorded at
`/tmp/g5-exact-config-replay-1.2.1.json` and preserves the four-node/four-edge
graph, conditional branch, handoff wait, reload wait ID, one accepted resume,
duplicate replay, and terminal `finalize_plan`.

The real configured model replay is recorded at
`/tmp/g5-agentloop-real-config-1.2.1.json`. From a normal
`createLocalGateway().submitTurn()` entry using
`provider1/qwen3.6-flash-distill`, the model executed `read_file` and the
owner-controlled `submit_step_result`, entered handoff, survived Gateway
recreation with the same wait ID, accepted one human resume, replayed the
duplicate without a second state transition, and reached `completed` for
`project_delivery_plan@1.2.1`.

The focused SOP suite passed 31/31 after this adapter-only change. Existing
disabled-composition and runtime-unavailable tests remain part of the focused
Gateway/config coverage; no disabled or unavailable path is reported as a
successful SOP run.

### Natural Permissioned Runtime Recheck

The initial real-provider script established callable wiring but used an
explicit `bypassPermissions` fixture. It is retained only as a protocol
sub-check. The primary runtime evidence is now
`evidence/g5-agentloop-natural-1.2.1.json`, produced by
`evidence/g5-agentloop-natural-run.mjs` with `mode: default` and ordinary
project-delivery messages that never name `submit_step_result` or prescribe a
result status.

The real model selected the configured
`project_delivery_plan@1.2.1`, executed `read_file`, and advanced through the
published graph to `confirm_scope`. The owner created a human `handoff` wait;
after Gateway recreation the same wait ID remained visible. A human approval
was accepted once, its duplicate replay was idempotent, and normal subsequent
turns completed `finalize_plan`. The graph and lifecycle owner were unchanged.

StaffDeck's native Router selects a published, agent-visible SOP from
`trigger_intents`; PilotDeck's current protocol profile instead has an explicit
deployment default (`defaultSopId`). This evidence validates that formal
default binding, not automatic multi-SOP discovery. The stored SOP snapshot
test additionally proves an existing session retains its initial definition
while a new session receives the newly configured version.

## Follow-up Runtime Evidence

After installing the lockfile with Node 22.22.0, the isolated StaffDeck
portable runtime was started on `127.0.0.1:16200` with a temporary SQLite file,
`APP_SECRET=g5-local-secret-16200`, and the isolated Python environment. The
real PilotDeck Gateway tests then consumed that service through
`sop.lifecycle/v2`:

```text
test:sop:core                 30 passed
test:sop:http-e2e             10 passed, 0 skipped
process-restart-sop-resume   status=passed, sopStatus=completed, duplicate=true
```

The restart smoke proves a new PilotDeck process reloads the persisted SOP
session state, resumes the same handoff once, and deduplicates the repeated
resume request. The HTTP matrix also covered disabled composition, handoff and
external waits, stale/concurrent state, malformed responses, HTTP 500, and
timeouts. The service and temporary database were stopped/removed after the
run.
