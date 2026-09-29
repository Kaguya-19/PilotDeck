# StaffDeck Frontend Adapter Map

This document records the supported PilotDeck frontend surface for the formal
StaffDeck profile. It is a boundary record, not a second product API.

## Source And Boundary

The reference owner UI is the StaffDeck enterprise frontend at
`frontend-enterprise/src/pages/KnowledgePage.tsx` and
`frontend-enterprise/src/pages/SkillsPage.tsx`.

Those pages cannot be imported into PilotDeck directly. They require the
StaffDeck enterprise router, `EnterpriseAuthUser` and employee scope state,
the enterprise component/alias tree, the StaffDeck toast system, and direct
`/api/enterprise/*` access. PilotDeck deliberately does not embed that app or
proxy its private API namespace. The selected module contract is the adapter
boundary.

| StaffDeck owner surface | PilotDeck adapter surface | Contract operation | Status |
| --- | --- | --- | --- |
| Knowledge-base list and create | Knowledge workspace list and create | `list_bases`, `create_base` | supported |
| Knowledge-base detail, archive, delete | Adapter management actions | `get_base`, `update_base`, `delete_base` | contract supported; scope/enterprise gallery policy remains StaffDeck-only |
| Version list, sync, promote, rollback | Adapter lifecycle actions | `list_versions`, `sync_base`, `publish_version`, `rollback_version` | contract supported; promotion needs an explicit StaffDeck agent scope |
| Document list, source editor, archive | Adapter document workspace | `list_documents`, `get_document`, `import_document`, `update_document`, `delete_document` | supported |
| Ingestion jobs and discoveries | Adapter progress/decision views | `list_jobs`, `get_job`, `cancel_job`, `list_discoveries`, `confirm_discovery`, `reject_discovery` | contract supported |
| Knowledge graph / OKF editor | No direct PilotDeck clone | `list_okf_concepts`, `upsert_okf_concept`, `export_okf`, `lint_okf` | contract available; graph canvas depends on StaffDeck enterprise graph UI and is intentionally not embedded |
| Search evidence and source drawer | Knowledge search and citation inspector | `query`, `resolve_citation` | supported |
| StaffDeck enterprise SOP list/editor | Host-owned SOP definition workspace | deployment YAML read/write | supported as host management, not a `sop.lifecycle/v2` feature |
| StaffDeck SOP run / handoff | PilotDeck chat wait and resume flow | `prepare`, `submit`, `status`, `resume` | supported by the existing Gateway/SOP bridge |
| Enterprise SOP publish/version/copy | No PilotDeck replacement | none in `sop.lifecycle/v2` | unavailable by contract |

## Runtime Safety

`GET /api/modules/runtime` reports two separate facts:

1. The Express service has read a profile matching the generated frontend.
   This allows independent Knowledge and host-definition management pages.
2. The Gateway is operational and no saved SOP definition is waiting for a
   runtime restart. Only then are runtime-required SOP chat controls and
   approval panels registered.

Writing a SOP definition returns `restartRequired: true`. The module runtime
marks the SOP slot unavailable for chat actions until the PilotDeck runtime is
restarted; the YAML file and the already-running SOP instance are not treated
as equivalent.

## Reuse Decisions

The adapter follows the StaffDeck owner interaction model: searchable resource
lists, detail editing, explicit lifecycle actions, persisted job status and
vendor/citation inspection. Its typed `KnowledgeClient` is intentionally kept
inside the StaffDeck module adapter so StaffDeck records never enter the common
PilotDeck chat/store types. PilotDeck continues to reuse its own application
shell, authentication client, settings system, session runtime, permission
registry, CodeMirror, terminal, and artifact preview surfaces.
