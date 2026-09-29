# G5 SOP Version Lineage

This record ties the formal shared-page save and publish response to the
definition consumed by the real PilotDeck run. Matching only the SOP ID would
be insufficient.

## UI Records

| Host surface | ID / version | Structure after save and reload | Role |
| --- | --- | --- | --- |
| PilotDeck shared editor | `project_delivery_plan@1.1.0` | 4 nodes, 4 edges; `collect_status -> build_plan`, conditional `build_plan -> confirm_scope/finalize_plan`, and `confirm_scope -> finalize_plan` | Authoring graph; reload preserved all nodes and edges |
| StaffDeck shared editor before this run | `project_delivery_plan@1.1.0` | 2 local nodes, 1 edge: `n1_collect -> n2_plan` | Baseline branch; reload preserved its retry/terminal fields |
| StaffDeck shared editor for this run | `project_delivery_plan@1.2.0` | 4 nodes, 4 edges; `n1_collect -> build_plan`, `build_plan -> confirm_scope/finalize_plan`, and `confirm_scope -> finalize_plan` | Saved through the page save dialog, reloaded, then published through the page's normal publish confirmation |

The StaffDeck page publish returned an active `1.2.0` version object. That
response is preserved in `g5-page-published-1.2.0.json`; it is the runtime
source of truth for the primary run below. The earlier `1.0.2` management-only
run remains supplemental evidence and is not used to claim this page chain.

## Adapter And Publish Binding

Both host adapters address the StaffDeck management resource for
`agent_preset_project_001` through the configured management endpoint. The
StaffDeck page calls the shared business adapter, which performs the normal
draft save and then `publish`; the adapter's returned version is visible in
the page's version-management dialog and was fetched again through
`GET /api/v1/sops/project_delivery_plan/versions/1.2.0`.

The primary run now points `modules.sop.definitionsPath` directly at that
page-published response. PilotDeck's definition loader accepts the management
response shape and normalizes it at the adapter boundary; the runner does not
construct or inject a replacement bundle. Its content has 4 nodes, 4 edges,
the page-authored conditions and labels, and no capability references were
removed by the loader.

## Minimal Replay

Build PilotDeck first and start the StaffDeck SOP sidecar at the configured
local endpoint. No API key is embedded in the runner.

```sh
cd /Users/a1/Desktop/claw/openbmb/PilotDeck-g5-sop-agent
NODE_OPTIONS='' \
G5_PUBLISHED_SOP_JSON=$PWD/products/pilotdeck-staffdeck-sop/evidence/g5-page-published-1.2.0.json \
G5_SOP_VERSION=1.2.0 \
STAFFDECK_SOP_ENDPOINT=http://127.0.0.1:16213 \
G5_OUTPUT_PATH=/tmp/g5-real-run.json \
node --import tsx products/pilotdeck-staffdeck-sop/evidence/g5-real-run.mjs
```

The replay asserts a durable handoff, identical wait ID after gateway reload,
single acceptance plus duplicate replay for the same request ID, and terminal
completion at `finalize_plan` with `scope_confirmed: true`. The exact-object
configuration replay was recorded at `/tmp/g5-exact-config-replay-1.2.1.json`.

The real-provider normal-entry replay uses the same exact published file and
configuration contract. It is recorded at
`/tmp/g5-agentloop-real-config-1.2.1.json`: the configured model executed
`read_file` and `submit_step_result`, entered a handoff, retained the same wait
ID across Gateway recreation, accepted one resume and replayed the duplicate,
then reached `completed`.

The primary normal-permission record is
`evidence/g5-agentloop-natural-1.2.1.json`. It uses `mode: default`, ordinary
project-delivery messages, and only the required `read_file` capability plus
the host-owned SOP result tool. The user messages do not name the control tool
or prescribe a result state. The model naturally selected the configured
published SOP, reached `confirm_scope`, created the owner handoff, and
completed `finalize_plan` after one human approval and an idempotent duplicate.

## Verification Notes

- PilotDeck host route/onboarding checks: 113 passed.
- The StaffDeck targeted pytest process exits 139 during macOS pytest capture
  initialization before collecting a result; this remains an environment
  limitation, not a passing behavior claim.
- Primary page-published replay output: `/tmp/g5-ui-published-real-run.json`;
  it records `project_delivery_plan@1.2.0`, 4 nodes, 4 edges, a durable
  handoff, identical wait ID after reload, one accepted resume plus duplicate
  replay, and terminal `finalize_plan` completion.
- The temporary sidecar used for the run was stopped after evidence capture;
  its generated `backend/staffdeck-runtime.applied*.json` files were removed.
