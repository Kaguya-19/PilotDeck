# Adapter/context execution handoff — same consolidated G0–G7 candidate

Execution owner: `01a0e22b-8565-7db3-92f3-cc4b2f8eef6f`.
Integration/public-file owner: `01a0e240-e9c4-76b0-991e-a2144273b08c`.

Isolated directory: `/Users/a1/Documents/Codex/2026-09-27/g2-adapter-context-owner/pilotdeck`.
Branch: `codex/g2-adapter-context-owner`.
Parent: PD `5e4dfd235477230f0200ee0bd710347a355ac807`; original committed tree in `g4-knowledge-dialog-fix/pilotdeck` was clean at inspection. Its matching audited SD ref is `01fb898ecd7c0bf2b5a6991577f2f5a7e79bedb1`. This is a scoped adapter delta, not a replacement 0.1.13 candidate. No shared 13-source snapshot, lock, upstream marker, core module, AgentLoop, permission policy, or runtime bundle is changed.

Initial worktree checkout encountered a missing remote LFS image; checkout with `GIT_LFS_SKIP_SMUDGE=1` succeeded. Image pointers are unchanged. No dirty source from another session was read. Existing 0.1.13 adapter deltas, if supplied by their owner, must be preserved when integrating this patch; do not replace complete files blindly.

## File ownership

This line owns existing `ui/src/composition/modules/staffdeck/clients.ts`, `vendor/knowledge-host-adapter.tsx`, `vendor/skills-host-adapter.tsx`, `vendor/copy-scope.ts`, and their adapter contract fixtures/tests. New files owned by this line: `host-notify.ts`, `clients.test.ts`, `vendor/skills-host-adapter.test.tsx`, and `ui/server/adapters/staffdeck-request-context.{js,test.js}`. The capability/runtime line provides independent helpers for D13–D15; this line alone wires those helpers into existing adapters.

Integration owns `ui/server/routes/modules.js`, shared Host bridge/page files, ToastContext, shared-source extraction/distribution, lock/vendor/version files, and final serial builds. The server helper in this commit is deliberately supplied for that owner to connect; its existence is not evidence that production routes already use it.

## Consolidated disposition

| Group | Implemented in this delta | Remaining dependency / acceptance state |
|---|---|---|
| D08 | Per-mounted-provider copy directory/target closure; independent editor snapshot maps; retained scope storage key; editor now waits for directory+management bootstrap; pending bootstrap aborts on unmount. Existing visible non-target employee selection remains supported. | Shared `activeHost`/`mountedHost` and tenant source must be restored by the shared-file owner. Existing management status has no formal tenant metadata and copy-directory projection omits tenant. Do not rename old cache namespaces to compensate. Team context remains tied to the original shared helpers/contract. G2/I01–I03 **NOT RUN**. |
| D09 | Shared `ApiError` instance with original status/code/raw body, validation locations and HTML error handling; no retry; actual `AbortSignal` reaches browser fetch for client calls, editor reads and signal posts; provider cancellation stops bootstrap. | Route owner must connect the request signal helper into every upstream fetch including identity reads. Shared class constructor restoration is still a bridge dependency. No production-route cancellation claim; **NOT RUN**. |
| D10 | None; belongs to UI/helpers owner. | No conflicting pure-helper rewrite in this line. |
| D11 | Root KB create/update/delete query scope retained; body cannot override query tenant/agent or path KB ID. Existing document/concept scoped writes retained. | Server PEP/identity scope proof remains D18; **NOT RUN**. |
| D12 | Collection create returns a formal SkillRead projection and records that exact created draft/content/version/ETag as first snapshot. Selected draft identity is checked. Subsequent replace uses the original snapshot draftID+ETag; conflict cannot update the snapshot or trigger another create. Extension content retained. | Public-route owner must wire `staffDeckCreateContent` so `sopId` wins over body content, and same-response ETag projection where necessary. No precreate/autopublish or dirty clearing. Real persistent first-save/reload **NOT RUN**. |
| D13–D15 | Removed false equivalence of move-to-draft→create and Remove→archive: explicit unavailable errors until equivalent public capability helpers are supplied. Distill Knowledge list preserves tenant/agent query. Adjacent Knowledge paths/methods reject rather than entering a nearby operation; encoded IDs/query `concept_type` retained and `include_all_versions=false` becomes actual boolean false. | Capability helper wiring awaits that line. Whitelist expansion and SOP cancel scope remain **BLOCKED**, not approved. No scope/key/token/core change. |
| D16 | Knowledge/Skills/Distill all use the visible host toast event; success/warning/error/info tones remain distinct. | Public owner must add warning to ToastContext's declared kind/palette. Real UI toast/i18n sampling **NOT RUN**. |
| D17 | Latest draft chosen by actual returned dates regardless of ordering; ambiguous/missing timestamps with multiple drafts reject. Single draft missing date remains missing, never now. Draft version takes formal draft_version over stale content.version. Missing list/version-list/result envelope rejects; branch_status is not invented. Bad export rejects instead of fabricating a JSON archive. | Real multiple-draft/date UI and selected published details **NOT RUN**. Original statistics' defined zero fallback is retained, not relabeled as fake data. |
| D18 | Preserved exact client scope and copy actor checks already provided by the server; no native backend imports or credentials moved to the browser. | Existing native Knowledge facade calls read functions without automatically executing their FastAPI dependencies. Per-request PDuser/actor/tenant/target/ownedcredential and native original-visible-scope proof is still needed through public glue. Do not silently treat configuration IDs as PEP proof or alter Knowledge core. **BLOCKED** for complete identity signoff; no observed runtime leak claim. |

## Server helper interface for the public-file owner

Import from `ui/server/adapters/staffdeck-request-context.js`:

- `createStaffDeckRequestContext(req, res, timeoutMs)` returns `{ signal, dispose }`. Pass `signal` into identity and business fetch calls. Dispose in `finally`. Browser `req.aborted` or unfinished response `close` aborts that request; completed responses do not abort, and cleanup of one context does not cancel another.
- `staffDeckCreateContent(input)` returns a new content object, setting `skill_id` from `input.sopId` when present and preserving all other content fields/extensions. Use for the existing `create` POST body; it adds no route/method/scope.
- `staffDeckDraftResponse(payload, response, operation)` attaches only that response's ETag for create/get_draft/replace_draft/rollback when absent from its payload. Never fetch another ETag to endorse earlier content.

Identity connection must preserve the original visible scope/owner rules. These helpers do not grant permissions or change the whitelist. Shared `ApiError` should retain the source `(status, rawBody, statusText)` constructor and class identity; client construction accommodates that signature.

## Focused verification and practical limits

Self-checks execute isolated changed source with test dependencies from the clean fixed PD checkout. No sibling node_modules symlink is introduced or committed. This reuse is a local verification convenience, **not** fresh/locked installation or production build evidence. Final builds/typecheck and complete cleanpair remain the integrator's serial responsibility.

Commands after normal locked dependency installation in the integrated tree:

```sh
pnpm --dir ui exec vitest run src/composition/modules/staffdeck/clients.test.ts src/composition/modules/staffdeck/vendor/skills-host-adapter.test.tsx src/composition/modules/staffdeck/vendor/knowledge-host-adapter.test.tsx src/composition/modules/staffdeck/vendor/copy-page.test.tsx
node --test ui/server/adapters/staffdeck-request-context.test.js
git diff --check
```

Results: 39/39 focused frontend tests and 4/4 server helper tests passed; `git diff --check` passed. No full build/typecheck or live UI/identity acceptance was run.

Local logs/config: `/Users/a1/Documents/Codex/2026-09-27/g2-adapter-context-owner/verification/`. Initial tooling failures (no node in PATH; Vitest CJS resolution) were corrected in that external test config. Regression tests exposed missing drafts arrays in old fixtures and synchronous expectations before the new editor bootstrap; fixtures now match the real response and await actual readiness. No business failure was renamed PASS.

No business services, independent 164xx run, new candidate round, provider/model call, push, merge, deployment or cache clearing in a live user environment. All real G0–G7 acceptance remains with the one final cleanpair and independent matrix.

## Integration receipt for immutable a7518c10

The integrator preserved the six transferred 0.1.13 adapter WIP files in PD2b07a78a before merging this delta by three-way hunks. The mutable adapter-context.patch already contained five commits at intake; this receipt adopts only a7518c1094d1a7df7cc8db50bed2da5a46bbfa8f, exported as adapter-wip-handoff/adapter-a7518c10.commit.patch. Subsequent committed helpers and row-ID follow-up are not included in this receipt and are not replaced by integrator rewrites.

Conflict resolution retains the exact existing path/method guards, authoritative path/query IDs, date locale and formal directory tenant; combines these with the owner's per-mounted copy context, signals, raw ApiError and draft lifecycle. Tenant is held inside each context alongside target; old ultrarag_enterprise_agent_scope and skill-distill cache key syntax are unchanged. The copy-client options parameter is declared to match the delivered use of options.signal. Test fixtures now contain the formal tenant supplied by the actual copy route.

The supplied request-context helper now powers the existing module abort boundary, with disposal on response finish/close and per-upstream configured timeout composition. Optional timeout avoids an extra timer at the shared middleware boundary; unfinished closure is based on writableFinished. The copy router also uses that signal, including its authenticated directory calls. modules.js uses staffDeckCreateContent after its existing SOP_ID_MISMATCH guard and uses staffDeckDraftResponse for the same response's ETag; it does not silently reassign conflicting content IDs. Management bootstrap already returns verified tenantId/actorUserId/agentId, and Toast warning is already visible.

Shared SD4fafd1aa removes the remaining Knowledge/Skills module activeHost facades. Actual child Markdown rendering, date/sort locale and Skills pagination use their mounted Host. The canonical 39 sources are distributed identically to PD; UI owner receives a separate incremental patch, preserving its primitive work.

Focused integration evidence: 39 adapter tests pass; seven actual Host contracts pass after correcting the old move-to-draft approximation test to assert explicit first-edit create from the selected snapshot and zero writes for blocked move-to-draft. Six request-context/abort node tests, six actual public HTTP route tests and nine copy bridge tests pass. Eight SD shared-page/boundary tests pass, including concurrent Markdown Hosts, sibling unmount and Skills pagination isolation. Logs, initial failures and vendor evidence are in the external integration intake handoff directories. These checks are not complete PEP/native-visible-scope, persistence, build/typecheck, real runtime pin/wait/model or G-gate signoff.

Known remaining integration dependencies: a7518c10's toManagedSkill still substitutes skill_id for the formal row ID, and its client extracts result without preserving sibling runtime for UI. Later owner work is not silently claimed by this receipt. Whitelist/cancel and non-equivalent public operations remain blocked; G0–G7 states do not change.

## Integration receipt for helper follow-up 3fa7b145

Adopted immutable 3fa7b14546289a01c51e44b69684e8ab9101c229, parent a7518c10. Its helper semantics now live in SD packages/staffdeck-business-ui/src/FormalHostContractHelpers.ts with a package export. Knowledge/Distill Hosts re-export that common source; prior FormalClipboard/FormalCatalogEvents/FormalHandoff paths, source scope normalization and the original four native SD library paths also re-export it. The PD host-contract-helpers.ts leaf re-exports the distributed canonical file, never the reverse. No independently maintained second implementation remains at these paths.

The copy context preserves a stored nonempty team scope and returns no employee for it; a bare team: still follows the original isTeamScope false contract. This is merged with the already-preserved formal tenant and independent target context, without changing cache/storage keys. PD Host scope mutations and team predicates use the shared helpers. The sole intended clipboard behavior correction restores focus before DOM ranges, retaining real copy-event payload, success rejection, cleanup and source trim/web/null behavior.

Integration self-checks: 28 SD tests across the original four library test files and actual shared page/boundary tests; 51 PD tests across the delivered helper/adapter tests and actual Host contracts. All pass. The added PD helper fixture includes the already-required formal tenant. Vendor verification passes all 40 canonical source files, and diff check passes. Server helper code is unchanged by this follow-up and its existing focused evidence is retained. Full builds, business/identity/model/runtime observations and gates remain unapproved. The later row-ID and runtime projection dependencies in the first receipt remain separate.

## Integration receipt for row-ID follow-up 1524821d

Adopted immutable 1524821d01c6ce087dfc753d35a6d3e93af7de56, parent 3fa7b145. It preserves the formal owner/public-draft row ID in SkillRead.id; skill_id remains the SOP identity, and draftID/ETag/snapshot path still come from the same draft lifecycle. The prior receipts' pending row-ID item is now implemented; runtime sibling projection remains separate.

The integrator also guards the direct toSkill published-version projection against missing row IDs, so that route cannot bypass toManagedSkill's rejection. Focused tests reject missing IDs for list, first create and direct published-version reads, preserve owner-row versus SOP-ID requests, and verify subsequent same-draft replace. All 31 tests in skills-host-adapter, copy-page and host-contracts pass; raw log is adapter-wip-handoff/adapter-row-id-integrated-tests.log, diff check passes. No new operation/authorization, server/browser helper import, retry, save, publish, runtime assertion or gate approval is introduced. Only this immutable third commit is accepted; the evolving patch's later public adapter commits are outside this receipt.

## Accepted pure protocol boundary correction

`createPublicCapabilityClient({agentId,transport,authorizedOperations: []})` is a server-only protocol interface by the capability owner's explicit placement contract: the public-route owner supplies the existing verified principal/target/owned credential transport and an explicitly approved operation list. Both delivered helpers remain server-only even though the public capability helper has no Node imports. No browser import/injection of `ui/server/*`, direct browser-to-SD request or browser SD credential acquisition is permitted. Browser code consumes only the existing `/api/modules/sop/management/call` or another explicitly approved formal module contract. Its raw failure status/body must pass through the existing shared ApiError boundary. On later approved directory wiring, only the real `data[]` envelope can become the UI's expected collection; never default malformed data to empty. Its 202/job/result and actual SSE events cannot become original temporary preview/token events, or trigger a second create. The original dirty/current_skill/conversation path remains blocked until a real preview contract exists; saved rewrite must not silently save dirty input. Cancel and unavailable equivalent operations remain blocked. The helper's 13 passing tests are separate from this line's tests and are not adapter or G gate acceptance.

## Gateway-facing public adapter consumption interface

Following the capability owner confirmation (no overlapping adapter WIP), this line adds `ui/src/composition/modules/staffdeck/public-capability-adapter.ts` and 8 focused tests. It accepts `{client, decodeEvents}` as a browser facade over the authorized module gateway response/event contract. These arguments must not be the server helper objects: the public module route invokes the server-only capability client/SD SSE decoder, while browser code receives only the approved gateway response/stream. No physical server helper relocation or import into the frontend is allowed.

```ts
// Browser: facade over the existing/explicitly approved module contract only.
const adapter = createPublicCapabilityAdapter({
  client: existingAuthorizedModuleGatewayFacade,
  decodeEvents: existingModuleGatewayEventDecoder,
});
// Server route owner only (not a frontend import):
// createPublicCapabilityClient({ agentId: verifiedAgentId,
//   transport: existingAuthorizedStaffDeckTransport,
//   authorizedOperations: [] }); // unchanged while approval is pending
```

This browser module does not initialize or import the server helper in production, advertise operations, add routes or populate authorization. It is ready for the explicitly approved connection only. Existing native temporary-generation/dirty-rewrite paths remain semantically blocked; those paths must not call `acceptedJob` as a substitute.

- `collection(op,input,signal)` projects only a formal data array; malformed shape is an error. Returned rows/extensions are untouched.
- `response(op,input,signal)` preserves actual successful status/body/headers, including ETag. `operation` is a body-only convenience when the consuming UI specifically expects that shape. Raw non-2xx status/body/code and typed local protocol errors enter the same shared ApiError boundary; AbortError passes through without retry or silent cancellation.
- `acceptedJob(op,input,signal)` returns the original 202/job/headers. No completion toast, stream token event, draft creation or snapshot mutation is inferred from acceptance. Actual result drafts remain unchanged for explicit editor lifecycle adoption.
- `events({jobId,lastEventId,signal,onEvent,onConsumedId})` consumes the committed decoder's original `{id,event,data}`; it does not parse or rename data, synthesize chunk/message_chunk or reconnect. It acknowledges a consumed ID only after the event consumer returns successfully. An empty ID resets the cursor and is omitted from the next Last-Event-ID input. Consumer rejection/abort does not advance a cursor or call cancel. Cursor state is local to that invocation.

Host notifications remain the existing `staffDeckNotify` tone contract; consumers show actual failure/completion states, not success on 202 acceptance. Public route owner still owns transport/whitelist and runtime-publish integration. New frontend focused total: 53/53 (6 files); server helper remains 4/4. No production enablement or real protocol/identity/model acceptance is claimed.


## Final helper placement correction

The capability owner explicitly confirmed that **both** helpers in `4319eadd` are server-only. This supersedes the earlier inference that absence of Node imports made the protocol helper eligible for browser injection. No implementation ever imported `ui/server/*` into the frontend; the correction narrows the documented injection contract and source comments. `public-capability-adapter.ts` accepts only a facade over an authorized public module/gateway contract and that gateway's event decoder. The server route invokes `createPublicCapabilityClient` and `decodePublicJobEvents`; its HTTP status/body and actual events cross the formal module boundary. Server `runtimeError`, credentials, configuration objects and direct SD transport do not cross it. No pending operation/route was enabled.


## Integration receipt for public adapter8e8d5cdf (historical placement superseded below)

Accepted immutable8e8d5cdf4fbdeca70b581f94dc5dc381445ade28, parent1524821d. Adopted its new adapter and eight tests, and exported moduleApiError from the existing preserved clients implementation. Prior integration receipts and their test counts are historical and remain intact; owner53/53 is source-line evidence, not the count of this focused integration run. The document conflict was resolved by preserving previous receipts and appending the exact new protocol/consumption contract. Laterd29e9a34 was not imported.

The pure capability protocol implementation is now single-source in ui/shared/staffdeck-public-capabilities.mjs; its bytes match the accepted4319eadd implementation. Its former server path is a narrow re-export. The Node publish/runtime helper and credential/identity transports remain service-side. No shared UI vendor, lock, core, route, authorization list or production client initialization changed. New operations still require an approved exact gateway contract; the original management whitelist is unchanged.

Focused integration: delivered adapter8 plus three actual helper-to-adapter consumer tests plus existing clients5 =16 PASS; original protocol tests through the server compatibility entry7/7 PASS. Logs: /Users/a1/Documents/Codex/2026-09-27/g0-g6-integration-intake/adapter-wip-handoff/adapter-8e8d5cdf-integrated-tests.log and public-protocol-relocation-tests.tap. Consumers exercise default empty authorization/zero transport, dirty rewrite zero transport, original202/result/ETag and real byte-split UTF-8 SSE accepted-before-cursor/empty-ID resume. No actual gateway/job/identity/model/runtime acceptance is claimed. Pending whitelist/cancel, non-equivalent preview, runtime sibling/UI, full builds and gates remain unchanged.

## d29e9a34 final server-only placement receipt

Accepted immutable d29e9a345708b45925141f6276320cd6acdb9611 (parent8e8d5cdf), applying its exact frontend comment and final gateway-only documentation contract. The capability owner's explicit SERVER-ONLY placement takes precedence over the previous inference from missing Node imports. Both4319eadd helpers stay under ui/server; no capability helper object/SD decoder is imported or injected into the browser. Frontend public-capability-adapter accepts only the authorized module gateway facade and that gateway's public stream decoder.

The integrator's ui/shared capability relocation and frontend helper-injection test from4505a24a are removed. Original server protocol implementation is restored byte-for-byte; its old path is again the implementation rather than a shared re-export. Earlier relocation test evidence remains historical and is not current-placement or gate evidence.

modules.js now provides a server-only createStaffDeckPublicCapabilityGateway after verified management owner context, binding createPublicCapabilityClient/decodePublicJobEvents to the same server credential transport as the original management calls. authorizedOperations is fixed at []; it does not take authorization from browser input. The prepared factory is not attached to a new operation dispatcher. Existing original-ten-operation management whitelist/advertisement is unchanged; no new route or SSE proxy is enabled pending approval. runtimeError/config/keys and direct StaffDeck transport remain server-side.

Focused checks justified by the transport extraction: six existing actual HTTP public-bridge cases plus two server gateway owner/default-denial cases =8/8 PASS. Raw: /Users/a1/Documents/Codex/2026-09-27/g0-g6-integration-intake/adapter-wip-handoff/adapter-server-placement-tests.log. Owner53 frontend+4 helper were not rerun for comment/doc changes. No dirty preview->saved job, cancel enablement, second publish or effective claim. Same integration, no new candidate/round or gate promotion.
Continued owner disposition and exact public/UI file handoff: [g2-adapter-remaining-integration-20260927.md](g2-adapter-remaining-integration-20260927.md). The latest focused adapter verification is 54/54 after fixing copy Signal and exposing every real draft row. Earlier counts remain historical local checks.
