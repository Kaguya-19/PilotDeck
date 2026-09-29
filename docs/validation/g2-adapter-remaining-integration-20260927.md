# Adapter/context remaining integration against the consolidated G0–G7 audit

Owner: adapter/context execution `01a0e22b-8565-7db3-92f3-cc4b2f8eef6f`. This is one scoped incremental handoff for the existing consolidated candidate, not a new acceptance round. The companion patch series starts from fixed PD `5e4dfd235477230f0200ee0bd710347a355ac807`; preserve all later 0.1.13 and other-owner work when integrating. Do not apply whole-file replacements over another line's committed or dirty changes. No shared Page/Host/core/vendor/lock, `ui/server/routes/modules.js`, or ToastContext file is edited by this line.

## Focused delta in this increment

- `clients.ts`: copy directory client now actually accepts `ModuleRequestOptions` and passes its `AbortSignal` into `authenticatedFetch`. Before this correction its body referenced an undeclared `options`; mounted directory cancellation could fail at runtime. The focused test aborts a pending real fetch promise with the same signal.
- `skills-host-adapter.tsx`: every formal draft row is retained with its own `id`, `draft_id`, date and `editorQuery`, preserving the published list order and draft order. The old latest-draft selection hid alternatives and could make a different draft publish. A publish URL with `draft_id` reads that exact draft; without it, a single draft still works, while multiple choices fail explicitly before a write. No latest ETag is used for older content. Missing published status no longer defaults to draft. Source `isTeamScope` recognizes only nonempty team IDs.
- `knowledge-host-adapter.tsx`: the `/api/enterprise/knowledge/knowledge-bases` read now retains its exact tenant and agent query scope.

Focused verification after these changes: 54/54 frontend adapter tests. This remains local contract evidence, not live G2/G7 PASS. `git diff --check` passed. No independent business run or service was started.

## Exact same-file UI handoff

`ui/src/composition/modules/staffdeck/vendor/SkillsPage.tsx` is UI-owner WIP. Only its owner should apply this source-level hunk at the selected-row publish action (currently near `publish` URL):

```tsx
const selectedDraft = row.draft_id ? `&draft_id=${encodeURIComponent(row.draft_id)}` : '';
await api.post(`/api/enterprise/skills/${encodeURIComponent(row.skill_id)}/publish?tenant_id=${TENANT_ID}${agentQuery()}${selectedDraft}`);
```

Keep the row's own `draft_id` through its click handler; do not derive it from latest list state or issue a prior create. The adapter recognizes this query and performs one `get_draft` for the selected row followed by one existing publish. Until this Page hunk is integrated, a multi-draft publish is an explicit error instead of silently publishing another draft. No new permission or operation is required.

## Precise public-file consumption contract for integrator

The following changes belong to the single `ui/server/routes/modules.js` and shared bridge/Toast owners. The adapter-owned helper is in `ui/server/adapters/staffdeck-request-context.js`; it is not wired by this line.

1. In each `/knowledge/call`, `/knowledge/query`, `/knowledge/citation`, `/sop/management` and `/sop/management/call` handler, create one `createStaffDeckRequestContext(req,res, timeoutMs)` for that browser request. Pass `context.signal` to **every** official identity/credential/directory lookup and the final upstream `fetch` (not just the last fetch). Call `context.dispose()` in `finally`. Preserve the original upstream abort/timeout distinction and send no success after disconnect. Do not share a controller across users or requests. The existing route still uses `AbortSignal.timeout` for upstream calls, so client cancellation is not currently proven end to end.
2. For existing SOP `create`, replace `body={content: input.content}` with `body={content: staffDeckCreateContent(input)}`. The helper clones content and makes the selected path `sopId` authoritative without dropping nodes/edges/extensions. For `create`, `get_draft`, `replace_draft`, and `rollback`, use `staffDeckDraftResponse(payload,response,operation)` on the **same** owner response before returning `{result}`. Do not fetch a newer ETag for older content. This connects the existing first-create and later-replace snapshot code without a second create or auto publish.
3. Expose verified, nonsecret host context through existing bootstrap responses: the current SOP management status returns `enabled/methods/agentId` after identity verification but omits tenant/actor; the copy `list_agents` projection omits tenant. Add tenant ID, actor ID and configured target ID from the already verified same-origin binding, not from browser body or a default constant. Do not add a new business operation or enlarge the pending whitelist merely to fill context. Shared Host owner must consume this context before mounting and replace module-level default `TENANT_ID`/`activeHost` with mounted provider context while retaining the existing cache/storage namespace and controlledClose/Escape contract. The adapter can then set `tenantId` from the verified response. Until that shared change lands, the current `tenant_demo`/`pilotdeck-local` values are presentation defaults and D08 tenant parity is **not closed**.
4. Knowledge calls currently overwrite `tenantId`/`actorUserId` from static module config, but accept caller `agentId`; a native module read invokes owner functions directly and does not automatically execute FastAPI route dependencies. Before calling the module, bind `req.user`, tenant, formal actor, selected target/non-target scope and owned credential on **each request**, and enforce the source-visible permission for that operation. Valid non-target or team context must follow the source policy; do not force every read to target merely for convenience. Do not infer PEP from an ID in config, copy status or HTTP 200. If this requires a new formal public facade/permission semantic beyond the current allowed glue, keep D18 **BLOCKED** and report the exact missing PEP; do not import SD private backend into PD or expand core permissions.
5. `ToastContext.tsx` currently accepts only `success | error | info`; add `warning` and its own visible styling so `staffDeckNotify.warning` stays a warning. The adapter already emits the correct `pilotdeck:toast` detail and does not map info to success. Sample success/failure/412 and language states in the eventual single cleanpair UI run; a dispatch-only test does not prove visibility.
6. The `host-contract-helpers.ts` source extraction belongs in the common package and must be re-exported by both formal Host implementations, then distributed from the same source to PD. Do not keep the drifted `normalizeCapabilityScope`, catalog event, handoff or clipboard stubs in shared Hosts. `copy-scope.ts` already consumes source `isTeamScope` and retains the original storage key.
7. Both capability line helpers in `4319eadd` stay server-only. The public capability helper's `authorizedOperations=[]` remains empty while whitelist approval is pending; cancel scope remains pending. The browser `public-capability-adapter.ts` accepts only a facade over the **existing or explicitly approved** module gateway response/event contract, never an import of `ui/server/*`, an SD key or a direct SD fetch. Its response/202/SSE consumption code is ready but production operation wiring is **not enabled**. The runtime coordinator belongs to the public route/Gateway owner and may wrap exactly one existing publish call; refresh acknowledgment remains `effective:false` pending observation.

## Disposition against the audit groups owned by this line

| Group | Scoped code evidence | Still needed for complete gate |
|---|---|---|
| D08 | Per-mount target directory and editor snapshot isolation; bootstrap abort; exact draft rows now retained. | Verified tenant/actor/target metadata and shared mounted Host bridge; team/non-target source PEP; real cache/dirty browser trace. |
| D09 | Shared-class ApiError with raw body/status/code; browser Signal now reaches Knowledge/SOP/copy fetch; server cancellation helper tested. | Public owner wires request-local signal into identity and business fetch; live request termination evidence. |
| D10 | Source scope/catalog/handoff/clipboard/normalize helpers supplied; team empty scope correctly handled. | Shared Host re-exports same package implementation; UI focus/selection and catalog events in final host. |
| D11 | Root/document/concept path IDs and query scope preserved; alternate KB list query scope now fixed. | Formal server identity/PEP and full original call map in final candidate. |
| D12 | First-create SkillRead and same-response draft snapshot; selected draft/ETag on replace. | Public owner applies create sopId and ETag helper; real persistent first-save/readback. |
| D16 | All three adapters emit correct host toast kind. | ToastContext warning styling and actual visible/i18n/412 UI evidence. |
| D17 | True row/draft IDs, versions, dates, strict envelopes, all multi-draft choices, no invented archive/date/branch status. | UI owner applies selected-draft publish query; real multiple-draft/date and history browser evidence. |
| D18 | Browser keeps scope/path inputs and no SD secret; server helper exposes no new authority. | Each-request formal actor/tenant/target/credential and owner-visible PEP. Still **BLOCKED**, no observed leak claim. |

D13–D15 missing equivalent public operations and white-list/cancel-scope decisions remain separate **BLOCKED** items. No key/token replacement, scope expansion, silent retry/save/rebase, archive-as-delete, auto publish, core behavior change, push, merge or deployment is part of this delta. G0–G7 statuses are unaffected by local focused tests.
