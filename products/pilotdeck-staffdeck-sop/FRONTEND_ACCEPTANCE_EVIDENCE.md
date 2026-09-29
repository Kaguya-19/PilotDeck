# StaffDeck Frontend Acceptance Evidence

This record distinguishes browser/component integration from real service
operations. It was produced against the local formal profile on 2026-09-22.

## Current G0-G7 Gate Status

This is the authoritative frontend status for the current working trees
(`StaffDeck shared UI f41c8524` and the current `codex/frontend-seven-slot-composition` branch). A build or source
inspection is not treated as proof of a real service workflow.

| Gate | Status | Evidence / limitation |
| --- | --- | --- |
| G0 scope and traceability | PASS | The source map and acceptance evidence are committed in reviewable revisions: StaffDeck shared UI `f41c8524` (parent `38ab57a6`) and the PilotDeck `codex/frontend-seven-slot-composition` evidence chain (`4b09f71b` implementation ancestor, `cd6f8b6e` matrix correction, `bad34814` runtime-fixture record, plus the current evidence revision). |
| G1 actual formal UI sharing | PASS | PilotDeck-hosted formal browser checks mount the shared StaffDeck Knowledge/SOP modules, and an independent StaffDeck-native host run at `http://127.0.0.1:15217` rendered `/enterprise/skills` and `/enterprise/knowledge` from the same shared build. The native run used an authenticated admin session and captured desktop screenshots under `/tmp/staffdeck-native-enterprise-skills.png` and `/tmp/staffdeck-native-enterprise-knowledge.png`; the observed API requests (`/api/enterprise/skills`, `/api/enterprise/knowledge-bases`, `/api/enterprise/knowledge/documents`, and `/api/enterprise/knowledge-bases/:id/okf/concepts`) all carried the JWT. |
| G2 generic glue/service boundary | PASS | The Knowledge adapter covers job polling, document deletion, sync/publish/rollback, and the focused adapter tests pass. The SOP adapter uses explicit management calls and reports unavailable host capabilities instead of falling back silently. |
| G3 seven-slot/profile assembly | PASS | The real browser matrix passes all seven required profiles (`pnpm run test:frontend-g3-browser-real`, with the versioned summary at [`evidence/frontend-g3-browser-real-report.json`](evidence/frontend-g3-browser-real-report.json); the ignored `test-results/` directory retains raw screenshots and per-state reports). Each state independently generated and Vite-built its entrypoint, navigated the chat surface, Settings module routes, `/always-on`, `/cron`, `/memory` legacy URLs, and the optional `/sop`/`/knowledge` routes. The report records the real PilotDeck runtime projection, JWT registration/login, request paths, and the real StaffDeck SOP/Knowledge auxiliary services for enabled profiles. The mock matrix remains available as a deterministic shell-boundary check; it is not used as the G3 pass criterion. |
| G4 Knowledge persistence loop | NOT RUN | The PilotDeck isolated lifecycle and formal shared UI cover query plus evidence-pack/source presentation. The independent StaffDeck-native host completed a real create/import/poll/update/query/delete API loop (`kb_92f4d04c4571478d`, job `kjob_92517a5b00734b5c`, document `kdoc_a44e4138cd3e4f60`; job `succeeded`, document `ready`, one evidence chunk and one evidence-pack item) and a shared-page edit/reload loop (`Native page edited` remained after `/enterprise/knowledge` reload). The required same-definition double-host page persistence loop is not closed; citation resolution remains a direct API contract check, not a claimed shared-page button flow. |
| G5 SOP edit/publish/run/reload | NOT RUN | Portable-definition persistence, public-management lifecycle API behavior, and isolated StaffDeck runtime consumption are recorded. On the independent StaffDeck-native host, the shared Distill editor saved `Native SOP acceptance` as v1.1.0, the list page preserved that name/version after reload, and the page publish confirmation returned the row to `Synchronized`. A new local fixture run against the current StaffDeck shared worktree also passed the real HTTP boundary (`test:sop:core` 30/30, `test:sop:http-e2e` 10/10) and process-restart handoff/resume (`process-restart-sop-resume`, `completed`, duplicate resume deduplicated); the temporary venv/runtime was cleaned up. This is protocol/runtime evidence only: the native temporary database still had no usable model configuration, and the required same-definition dual-host edit/publish/run/wait/resume proof is not closed. |
| G6 dual-host regression/reproducible delivery | PASS | The PilotDeck shared-page locale boundary now projects the formal StaffDeck English catalog only inside Knowledge/SOP roots; business data remains unchanged. StaffDeck `i18n:check` reports 3924 translations, both frontend builds pass, and an independent Playwright matrix passes Chinese/English at desktop/mobile on both hosts (8/8 states). StaffDeck Knowledge requests all carried JWTs; PilotDeck requests reached both module adapters. |
| G7 independent supervision evidence | NOT RUN | Do not mark this gate complete until the independent supervisor reruns G0-G6 against the final worktrees. |

The implementation must not be marked complete while G7 remains `NOT RUN`. The
commands used for the passing static checks are listed below.

## Latest Shared-Host Follow-Up (2026-09-22)

The earlier temporary-database note below is superseded by the verified
Knowledge-only module process currently bound to `/tmp/staffdeck-g45b.sqlite3`.
Its module call `get_document` returned document
`kdoc_fc74742ad3894a9d` (`pilotdeck-staffdeck-acceptance.md`) with a ready
bucket/chunk, and a real `query` for `cedar-47` returned one evidence-pack item
(`kchunk_b6d9baec88a248ac`) plus the source citation
`ultrarag://knowledge/documents/kdoc_fc74742ad3894a9d`. The query completed
with HTTP 200 through `/v2/module/call`. The configured model secret does not
match this database, so document and bucket routing recorded
`*_lexical_fallback`; this is an explicit degraded routing trace, not a failed
retrieval or an absent citation.

- StaffDeck native editing appended `双宿主 G4 acceptance marker 2026-09-22.` to the shared document in base `kb_dee9ad74d3a24492`; native API readback returned document `kdoc_f74aa10735064b29` with the updated `online_edited_at`.
- PilotDeck Vite `/knowledge` selected the same base, rendered its 17 citation/source entries, and sent a real `POST /api/modules/knowledge/call` query (HTTP 200). The retrieval trace reported `Secret cannot be decrypted with current APP_SECRET`, so this is not claimed as a successful marker query or G4 pass. The indexed chunks still do not contain the marker, which remains an index/re-read gap to resolve.
- PilotDeck `/sop` now correctly falls back to local YAML definitions when public SOP management is not configured. The module route returns `501 SOP_MANAGEMENT_UNAVAILABLE` only for that capability absence; configured upstream failures retain their original error status. This is fallback/error-classification evidence only, not G5 public-management or dual-host publish evidence.

## Knowledge: Real Isolated Lifecycle

The PilotDeck facade at `http://localhost:13121/api/modules/knowledge/call`
was used with a uniquely named temporary knowledge base. The acceptance run:

1. called `create_base`;
2. called `import_document` and polled `get_job` plus `list_documents` until
   the job was `succeeded` and the document was `ready`;
3. called `update_document`, then `get_document` and verified the updated
   title was returned;
4. called `query` scoped to that base and received one evidence chunk;
5. called `resolve_citation` for that chunk; and
6. called `delete_base` in a `finally` block.

Observed values from the completed run:

| Check | Evidence |
| --- | --- |
| Temporary base | `kb_22ee86ded9a84478` (cleaned) |
| Import job | `succeeded` |
| Document | `ready` |
| Update/readback | `Acceptance document updated` |
| Query | one evidence chunk |
| Citation | `kchunk_ac88b2807d424426` |

## Knowledge: Real Structure Editing

A second, separately created temporary base completed ingestion and then used
the extracted structure operations:

| Check | Evidence |
| --- | --- |
| Temporary base | `kb_90d75aa358cb4b02` (cleaned) |
| Import job | `succeeded` |
| Bucket update/read | title `Acceptance bucket` |
| Chunk update/read | summary `Updated chunk summary` and content `Updated cedar-47 chunk content` |

This run used `list_document_buckets`, `update_bucket`, `list_bucket_chunks`,
and `update_chunk` through the same PilotDeck facade.

The browser at `http://localhost:15121/knowledge` was also inspected in
Chinese. It rendered real seeded StaffDeck bases, document state, search, and
the extracted lifecycle/job/structure/OKF/discovery panels. Its evidence-pack
and source presentation is UI evidence. `resolve_citation` above is instead a
direct PilotDeck API contract check; the shared page currently does not expose
the old English `Resolve citation` click action.

## SOP: Browser Evidence

Portable SOP definitions were exercised through the local definition facade and
Gateway lifecycle. The formal browser path was then verified at `/sop` and
`/sop/distill?skill_id=operator_approval`: source view opened, name and
description changed, draft version `1.1.0` saved, reload preserved the updated
fields and original node, and the plaza reflected the updated name/version.

The public-management adapter was additionally exercised against an isolated
StaffDeck public API app. Its `drafts` response was loaded by stable `sop_id`,
the formal editor saved the complex `acceptance_complex` graph as version
`1.1.0`, and refresh preserved all three nodes, both conditions, capability
references, and the review retry policy. The SOP list page published the draft;
the public API then returned it in `data` and exposed it through
`list_versions`. A stale `If-Match` write returned `412 ETAG_MISMATCH` and the
original content was restored. This was a server-side public API validation,
not ordinary JWT-mode evidence, and it does not replace a StaffDeck-host
browser run or runtime-consumption proof. AI generation through the portable
Distill host intentionally returns an explicit unavailable error until a
streaming provider is supplied.

## SOP: StaffDeck Runtime Consumption

The StaffDeck formal page was exercised on the isolated acceptance service at
`http://127.0.0.1:5174` with Harness v3 and a local OpenAI-compatible model
fixture. The browser submitted `请按经营指标分析框架处理本月转化率问题` in a
fresh session after the SOP had been published. The durable event log recorded:

| Check | Evidence |
| --- | --- |
| Session | `session_0698f95a84523f40` |
| Skill/version binding | `skill_started`: `business_metric_analysis`, version `1.0.0`, first step `n1_collect` |
| Frame completion | `task_frame_finished`: `kind=sop`, `skill_id=business_metric_analysis`, status `awaiting_user`, action count `1` |
| Reply | `mock runtime consumed the published SOP definition; please confirm the analysis period.` |

The same flow was also observed advancing to `n2_framework` in
`session_b5ba8189ef677ee6`. This is a local acceptance fixture, not a claim
that an external provider was available; the fixture and isolated database
were removed after evidence capture.

## Focused Verification

```sh
env -u NODE_OPTIONS -u npm_config_node_options \
  PATH=/Users/a1/.nvm/versions/node/v22.22.0/bin:$PATH \
  pnpm --dir ui run typecheck

env -u NODE_OPTIONS -u npm_config_node_options \
  PATH=/Users/a1/.nvm/versions/node/v22.22.0/bin:$PATH \
  pnpm --dir ui exec vitest run src/composition/consumption.test.tsx server/routes/modules.test.js

env -u NODE_OPTIONS -u npm_config_node_options \
  PATH=/Users/a1/.nvm/versions/node/v22.22.0/bin:$PATH \
node --test scripts/generate-frontend-modules.test.mjs
```

## Browser Profile Checks

The StaffDeck-native host was independently started with an isolated build of
Harness v3 tag `dsh-v0.1.2-alpha.2` and a temporary SQLite database. With an
authenticated `tenant_demo/admin` session, the shared pages rendered at
`/enterprise/skills` and `/enterprise/knowledge` in both the default Chinese
locale and an `en-US` browser context. Static UI copy translated; seeded
knowledge/SOP names and document content intentionally remained business data.

The PilotDeck formal host was then run from `formal-host.yaml` against the same
StaffDeck service endpoints. Its vendored shared pages use
`StaffDeckLocaleBoundary` plus the StaffDeck source-string catalog, which keeps
the translation projection scoped to the shared page root instead of changing
the source product or chat surface.

The independent browser matrix used fresh contexts and authenticated login where
the host required it:

| Host | Locale | Viewports | Knowledge/SOP UI | Network evidence |
| --- | --- | --- | --- | --- |
| StaffDeck native | `zh-CN`, `en-US` | 1440x1000, 390x844 | 4/4 | 12 authenticated Knowledge/Skills requests per state |
| PilotDeck formal-host | `zh-CN`, `en` | 1440x1000, 390x844 | 4/4 | 6 Knowledge/SOP adapter requests per state |

All 8 states passed. Screenshots from the representative English captures are
`/tmp/staffdeck-native-knowledge-en.png`,
`/tmp/staffdeck-native-skills-en.png`,
`/tmp/pilotdeck-formal-host-knowledge-en.png`, and
`/tmp/pilotdeck-formal-host-sop-en.png`.

The native host's Knowledge API persistence probe created a temporary base,
uploaded and polled a Markdown document to `succeeded`/`ready`, updated the title,
queried one evidence chunk, and deleted the base in cleanup. The temporary base
and all generated records were removed before shutdown.

The local formal-host suite passed 6/6 at desktop and mobile viewports. Those
are PilotDeck-hosted checks of the shared StaffDeck modules, not a second
StaffDeck-native-host execution. The replacement runtime was started as an
independent process and observed its profile-owned `resultLimit: 3`.

After the adapter and authentication fixes, the authenticated route matrices
were rerun against direct Vite origins (the Express development server
redirects browser routes to Vite):

```sh
# formal-native: PilotDeck Skills present; SOP and Knowledge absent
FORMAL_ROUTE_PROFILE=native FORMAL_ROUTE_AUTH=1 \
FORMAL_COMPOSITION_URL=http://localhost:15118 \
pnpm --dir ui exec playwright test e2e/formal-route-matrix.spec.mjs \
  --config=e2e/formal-composition.config.mjs

# formal-minimal: Skills, SOP, and Knowledge absent
FORMAL_ROUTE_PROFILE=minimal FORMAL_ROUTE_AUTH=1 \
FORMAL_COMPOSITION_URL=http://localhost:15128 \
pnpm --dir ui exec playwright test e2e/formal-route-matrix.spec.mjs \
  --config=e2e/formal-composition.config.mjs
```

Each command passed 2/2 (desktop and mobile). The route test fixes the browser
locale to `zh-CN` for shared-page assertions and requires a profile with a
ready smoke model; otherwise the application correctly remains at onboarding.

The final shared-UI checks additionally passed:

```sh
env -u NODE_OPTIONS -u npm_config_node_options \
  PATH=/Users/a1/.nvm/versions/node/v22.22.0/bin:$PATH \
  pnpm --dir ui run typecheck
env -u NODE_OPTIONS -u npm_config_node_options \
  PATH=/Users/a1/.nvm/versions/node/v22.22.0/bin:$PATH \
  pnpm --dir ui run build
env -u NODE_OPTIONS -u npm_config_node_options \
  PATH=/Users/a1/.nvm/versions/node/v22.22.0/bin:$PATH \
  pnpm run i18n:check
env -u NODE_OPTIONS -u npm_config_node_options \
  PATH=/Users/a1/.nvm/versions/node/v22.22.0/bin:$PATH \
  pnpm run build
```

The first two commands run in PilotDeck (`ui`), and the last two run in
StaffDeck `frontend-enterprise`.
