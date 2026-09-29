# G4 Knowledge Evidence

## Scope and ownership

- PilotDeck isolation: `codex/g4-knowledge-pd` at `9f66017139d017239929b304331bfba01992cb5a`.
- StaffDeck isolation: `codex/g4-knowledge-sd` at `f41c8524bd129bcaea96f4f774d97a931e566636`.
- Formal shared source: `StaffDeck/packages/staffdeck-business-ui` (`@staffdeck/business-ui` `0.1.0`).
- PilotDeck consumes the checked-in vendor snapshot under `ui/src/composition/modules/staffdeck/vendor/`; the vendor check compares `KnowledgePage.tsx`, `KnowledgePageHost.tsx`, and the related shared files byte-for-byte with the SD package.
- StaffDeck production route `frontend-enterprise/src/pages/KnowledgePage.tsx` consumes the same package and supplies only `knowledgePageHost`.

## Protocol coverage

`ui/src/composition/modules/staffdeck/vendor/knowledge-host-adapter.test.tsx` covers the formal page's adapter mapping for base/document CRUD, asynchronous jobs and cancellation, versions and publish/rollback, buckets/chunks, OKF import/export/lint, discoveries, query, and citation resolution. The test also asserts unsupported paths fail instead of silently issuing an unrelated request.

`ui/server/routes/modules.test.js` covers the server-side `staffdeck.knowledge/v1` boundary. Binding `tenantId` and `actorUserId` are trusted identity values: browser-supplied values are overwritten, and missing binding identity returns `MODULE_IDENTITY_UNAVAILABLE`. Knowledge writes are rejected with `MODULE_ADMIN_REQUIRED` when `PILOTDECK_MODULE_ADMIN=0`; reads remain available.

## Real persistence path

The dual-host browser run starts the StaffDeck **formal** `app.main:app` entrypoint with the built Harness v3 engine, an isolated SQLite database, and the native `frontend-enterprise` Vite host. PilotDeck is started against that same StaffDeck service/database through the `staffdeck.knowledge/v1` module protocol. Both hosts exercise the shared Knowledge page: file-input import, persisted base/document reopen, edit/save, reload/readback with the unchanged field retained, and query.

The StaffDeck-native query assertion is page-visible: the runner expands the evidence-pack panel and verifies both `Owner approval` and `Unchanged field` in the rendered source excerpt. The report separately records the HTTP evidence-pack response and the PilotDeck API-only citation resolution. Model fixtures are not persistence evidence.

The runner also contains an explicitly labeled `G4_KNOWLEDGE_WRAPPER=1` startup-cleared Knowledge-only wrapper for integration debugging. That wrapper is not used for the formal acceptance result and must not be described as full StaffDeck startup coverage.

## Reproduction

From the PD worktree, install the declared workspace dependencies, then run:

```sh
env -u NODE_OPTIONS pnpm exec vitest run ui/src/composition/modules/staffdeck/vendor/knowledge-host-adapter.test.tsx ui/server/routes/modules.test.js
env -u NODE_OPTIONS pnpm exec vitest run tests/composition/real-staffdeck-seven-slot-e2e.spec.ts
env -u NODE_OPTIONS node scripts/verify-staffdeck-business-ui-vendor.mjs
env -u NODE_OPTIONS HARNESS_V3_ROOT=/Users/a1/Desktop/claw/openbmb/deepseek-harness-dsh-v0.1.2-alpha.2 /Users/a1/.nvm/versions/node/v22.13.1/bin/node scripts/g4-knowledge-browser.mjs
env -u NODE_OPTIONS HARNESS_V3_ROOT=/Users/a1/Desktop/claw/openbmb/deepseek-harness-dsh-v0.1.2-alpha.2 /Users/a1/.nvm/versions/node/v22.13.1/bin/node scripts/g4-knowledge-advanced-browser.mjs
env -u NODE_OPTIONS HARNESS_V3_ROOT=/Users/a1/Desktop/claw/openbmb/deepseek-harness-dsh-v0.1.2-alpha.2 /Users/a1/.nvm/versions/node/v22.13.1/bin/node scripts/g4-knowledge-cancel-discovery-browser.mjs
```

The focused route and adapter suites passed with 32 tests. The formal dual-host browser runner passed with `staffdeckStartup: formal_app_main_with_harness_v3`: PilotDeck UI and StaffDeck native UI both imported and persisted separate documents in the same isolated StaffDeck service/database; both edited and reloaded content; both submitted a non-empty query input; and StaffDeck rendered the required evidence-pack excerpt. The run used Node `22.13.1` with `NODE_OPTIONS` cleared and the reusable built Harness root above.

The captured report is `test-results/g4-knowledge-browser/report.json`. Screenshots are `test-results/g4-knowledge-browser/g4-knowledge-browser.png` (PilotDeck) and `test-results/g4-knowledge-browser/g4-knowledge-staffdeck-native.png` (StaffDeck native). Cleanup status is `test-results/g4-knowledge-browser/cleanup.json`.

The incremental native-capability report is `test-results/g4-knowledge-advanced-browser/report.json`, with screenshot `g4-knowledge-advanced-staffdeck.png` and its own cleanup record. It proves native StaffDeck bucket/chunk edit and reload, branch version listing and rollback (`HTTP 200`, head changed to the prior version), OKF export (`.zip`, `HTTP 200`), OKF lint (`HTTP 200`), and native OKF import failure (`HTTP 400`, invalid archive). The discovery UI was reached with no pending suggestion; confirm/reject therefore remains unavailable without a real model-produced pending suggestion. Cancellation likewise remains NOT RUN because this fixture has no long-running ingest window.

The focused incremental report is `test-results/g4-knowledge-cancel-discovery-browser/report.json`, with native and PilotDeck screenshots plus cleanup metadata. It uses a temporary `sitecustomize.py` delay fixture that holds the real ingest worker while preserving formal `app.main:app` startup; the UI creates the job and the cancellation endpoint performs the persisted transition. StaffDeck native cancellation reached `queued`, was cancelled from the UI, and remained `cancelled` after reload. StaffDeck native discovery used a local OpenAI-compatible model fixture only to return a traceable tool suggestion; pending creation, confirm, reject, and scoped status readback after reload were real. PilotDeck's shared page/adapter cancelled a queued job and verified the terminal state after reload. PilotDeck discovery remains `BLOCKED`: the adapter returned a pending model-fixture row, but the shared page did not render `Discover Resources to Add`, so no confirm/reject or terminal status is claimed. The runner records this required-capability failure and exits nonzero when the block remains.

## Limits

No credentials, database dumps, or running service output are committed. The browser runner uses an isolated temporary SQLite database and a local smoke model configuration; model responses are not used to establish Knowledge persistence. Harness v3 is supplied from the built checkout only so the normal StaffDeck startup path can initialize; unrelated Harness runtime operations are outside this Knowledge acceptance scope.

The reports' coverage fields are intentionally explicit: `import_document`, `update_document`, and `query` are real UI coverage on both hosts; `resolve_citation` is API-only PilotDeck module-protocol evidence; versions/rollback, buckets/chunks, and OKF export/lint have native StaffDeck UI evidence; invalid OKF import has a native failure-state assertion; StaffDeck native cancellation and discovery confirm/reject are real UI plus reload/readback; and PilotDeck cancellation is real shared-page/adapter UI plus reload/readback. PilotDeck discovery is BLOCKED on the missing modal, and PilotDeck-side versions/rollback, buckets/chunks, and OKF export/lint remain unrun and are not expanded from the StaffDeck-native evidence.
