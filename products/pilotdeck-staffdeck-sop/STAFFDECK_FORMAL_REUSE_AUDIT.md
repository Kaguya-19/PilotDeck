# StaffDeck Formal UI Reuse Audit

## Source Baseline

| Repository | Branch | Commit |
| --- | --- | --- |
| PilotDeck | `codex/frontend-seven-slot-composition` | `24b130f9` |
| StaffDeck | `codex/staffdeck-shared-business-ui` | `e755aaa4` |

The source enterprise pages depend on the StaffDeck enterprise router,
employee-scope storage, authentication, Toast provider, aliases, and direct
`/api/enterprise/*` requests. Those host concerns are now isolated behind the
versioned package bridges. The package owns the source-derived Knowledge and
SOP pages; each host supplies only API, scope, notification, routing, and UI
primitive adapters. PilotDeck vendors the exact package snapshot and never
imports a StaffDeck checkout at runtime.

## Reused Source Files

| Source | Reuse status and responsibility | PilotDeck destination |
| --- | --- | --- |
| `frontend-enterprise/src/pages/KnowledgePage.tsx` | StaffDeck formal Knowledge page is the source; the complete page and its add/import route are extracted into the versioned package. | `packages/staffdeck-business-ui/src/KnowledgePage.tsx`, `packages/staffdeck-business-ui/src/KnowledgePageHost.tsx` |
| `frontend-enterprise/src/components/KnowledgeGraphCanvas.tsx` | Production Knowledge page imports the versioned shared package directly; no sibling checkout is required by either host. | `packages/staffdeck-business-ui/src/KnowledgeGraphCanvas.tsx`, PilotDeck vendor snapshot |
| `frontend-enterprise/src/pages/SkillsPage.tsx` | StaffDeck formal SOP inventory page is the source; inventory, filters, copy/import, publish/archive/draft, version, rollback, ranking, and detail state are extracted into the versioned package. | `packages/staffdeck-business-ui/src/SkillsPage.tsx`, `packages/staffdeck-business-ui/src/SkillsPageHost.tsx` |
| `frontend-enterprise/src/pages/DistillPage.tsx` | StaffDeck formal Distill editor is extracted with source/flow views, field editing, draft save, and host-provided streaming/API hooks. | `packages/staffdeck-business-ui/src/DistillPage.tsx`, `packages/staffdeck-business-ui/src/DistillPageHost.tsx` |
| `frontend-enterprise/src/types/index.ts` | normalized record shapes for the shared public view models | `packages/staffdeck-business-ui/src/types.ts` |
| `backend/app/api/module_knowledge.py` | supported `staffdeck.knowledge/v1` operations and input shape | `ui/server/routes/modules.js`, `ui/src/composition/modules/staffdeck/clients.ts` |
| `backend/app/public_api/sops.py` | authoritative draft/ETag/publish/version management contract | SOP management adapter design; not substituted with the runtime lifecycle contract |

## Capability Matrix

Status meanings: **protocol** = module service exposes the operation;
**surface** = the extracted module presents it; **verified** = isolated real
operation evidence is recorded by the acceptance run.

| Area | Source operation | Module operation / transport | PilotDeck surface | Status |
| --- | --- | --- | --- | --- |
| Knowledge bases | list/create/update/delete | `list_bases`, `create_base`, `update_base`, `delete_base` | base list and details | surface; verification pending |
| Documents | list/read/import/update/archive | `list_documents`, `get_document`, `import_document`, `update_document`, `delete_document` | document editor | surface; verification pending |
| Version lifecycle | list/sync/promote/rollback | `list_versions`, `sync_base`, `publish_version`, `rollback_version` | formal lifecycle panel | surface; verification pending |
| Ingestion | list/get/cancel | `list_jobs`, `get_job`, `cancel_job` | jobs panel | surface; verification pending |
| Structure | list/update bucket and chunk | `list_document_buckets`, `update_bucket`, `list_bucket_chunks`, `update_chunk` | structure editor | surface; real isolated update/readback verified |
| OKF / graph | list/read/upsert/export/lint | `list_okf_concepts`, `get_okf_concept`, `upsert_okf_concept`, `export_okf`, `lint_okf` | OKF panel; canvas remains StaffDeck-only | surface; verification pending |
| Discoveries | list/confirm/reject | `list_discoveries`, `confirm_discovery`, `reject_discovery` | discovery panel | surface; verification pending |
| Retrieval | query/citation resolve | `query`, `resolve_citation` | search and citation inspector | surface; verification pending |
| SOP runtime | prepare/submit/status/resume | `sop.lifecycle/v2` through Gateway | chat wait, approval and resume | surface; verification pending |
| SOP management | draft/create/copy/validate/publish/archive/version/rollback | StaffDeck public SOP API or host-owned definition adapter | Shared formal Skills and Distill pages; PilotDeck local adapter supports definition read/save/reload and explicit streaming-unavailable errors | surface; local edit/reload verified, public API verification pending |

Real Knowledge lifecycle evidence is recorded in `FRONTEND_ACCEPTANCE_EVIDENCE.md`.

## Boundaries And Follow-up

`staffdeck.knowledge/v1` accepts the explicit `tenantId`, `actorUserId`, and
optionally `agentId` values required by StaffDeck. PilotDeck injects the first
two from the selected profile; branch promotion and rollback require an agent
scope provided by the operator. Those actions are presented as unavailable
until that value is supplied.

SOP YAML management belongs to the current portable deployment and is not
equivalent to StaffDeck's public draft/publish API. The shared Skills and
Distill pages preserve the original inventory, editing, and lifecycle surfaces
while the host adapter selects the configured public API or deployment-owned
definition service. PilotDeck's portable adapter supports local definition
editing and preserves unmodified node content; AI generation returns a clear
unavailable error until a streaming provider is configured. Scoped credentials
and ETag semantics remain server-side. The previous hand-written
`SopManagement` and `KnowledgeOperations` replacement panels were removed from
both hosts and are not part of the reuse claim.

## SOP Public Management Binding

The binding is optional. Omit it for portable SOP deployments; no formal
management panel is mounted. A deployment with StaffDeck's `/api/v1` public
API can configure it as follows (the API key must be injected by deployment
secret management, never committed):

```yaml
modules:
  sop:
    management:
      enabled: true
      endpoint: https://staffdeck.example/api/v1
      apiKeyEnv: STAFFDECK_SOP_PUBLIC_API_KEY
      agentId: employee-agent-id
      methods: [list, create, get_draft, replace_draft, validate, publish, archive, list_versions, get_version, rollback]
```

The public key must carry the corresponding `sops:read`, `sops:write`, and
`sops:publish` scopes. The facade forwards `If-Match` only for draft
replacement and never serializes the endpoint or key into generated frontend
code.

The source code remains attributed above. Extracted files contain no imports
from a sibling checkout and use only declared PilotDeck dependencies.

### Versioned Shared Package: `KnowledgeGraphCanvas`

The source file is published from StaffDeck commit
`4305310eecf70472849a81dfab20d7ff84a9fd80`. The package owns its public
`KnowledgeConceptRead` type and CSS alongside the canvas; the PilotDeck copy is
an exact vendor snapshot of the package release. The wrapper maps
module-client concept records into this public shape and handles selected
concept state. It contains no graph business logic.
