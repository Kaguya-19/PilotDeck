# Browser Knowledge search model selection, fixed public SDK contract

This is the minimum one-KB formal-page search contract. It keeps the PilotDeck host model catalog as the only model source and the StaffDeck Knowledge service as retrieval owner. It is a code/contract delivery, not a live search or model PASS.

## Adapter input

For the existing `search_knowledge_base` operation, send:

```ts
{
  knowledgeBaseId: selectedSingleBaseId,
  selectedPdModelId: selectedSearchModelId,
  body: { query, mode: 'debug', max_depth: 3, need_evidence_pack: true, /* original search filters */ }
}
```

The adapter must move the formal page's `model_config_id` value to the outer `selectedPdModelId` and remove `model_config_id` from `body`. It must not choose another ID or silently omit an empty/stale selection. The existing selected fixed-target scope and single KB ID stay unchanged. No browser credential or PD model provider object is added.

The selected value is the canonical PD catalog ID `provider/model`, as returned by `list_model_catalog`. It is **not** an SD `ModelConfig.id`. The public SDK rejects an SD `model_config_id`/`modelConfigId` in the body. The selected native host provider now publishes canonical IDs; the existing Gateway model catalog already does so.

## Server composition input

`createPublicCapabilityClient` has one optional `hostModelCatalog({signal})` callback. It becomes **required for this operation**: without it, `search_knowledge_base` fails with `PUBLIC_PD_MODEL_CATALOG_UNAVAILABLE` (503) before an SD request. The callback returns the body of the selected authenticated PD host `list_model_catalog` Port response: `{data:[{id,provider,model,available?,enabled?,is_default?}],defaultSelection?}`. It must use the same runtime/profile and principal as the browser's host catalog. The composition owner supplies this callback in `createStaffDeckPublicCapabilityGateway`, using the already selected `getGateway` and `createPilotDeckHostCapabilityGateway`; a non-2xx host result remains an error. No new catalog or model runtime is constructed. The root and `modules.js` remain integration-owned.

The SDK checks exactly one current default and its canonical ID. The requested ID must equal that default and be available. A different enabled catalog entry is a mismatch, not an implicit model switch. Router auto selection and session-level overrides have no browser search authority in this minimum contract. If those are active, this path rejects until a session-bound selection contract exists.

After validation, the SDK sends the original search body to `POST /api/v1/agents/{agent_id}/knowledge-bases/{knowledge_base_id}:search`; it never forwards the PD ID as SD `model_config_id`. The SD endpoint continues its existing credential, target, KB and resource PEP checks and `use_public_host_retrieval()` selection. The successful Knowledge response retains original `trace`, chunks, evidence and citations and adds:

```json
"host_model_selection": {
  "id": "provider/model",
  "model_use": "pilotdeck_dialogue_only",
  "retrieval_mode": "staffdeck_public_lexical"
}
```

This field records the validated selection and the source distinction; it does not claim the formal-page retrieval invoked the PD model. Raw SD search failures keep their original HTTP response and body.

## Error boundary and focused evidence

`PUBLIC_PD_MODEL_SELECTION_REQUIRED` (400) covers an empty browser selection; `PUBLIC_SD_MODEL_SELECTION_FORBIDDEN` (400) covers SD model fields; `PUBLIC_PD_MODEL_CATALOG_INVALID` (502) covers missing/ambiguous default or malformed IDs; `PUBLIC_PD_MODEL_SELECTION_MISMATCH` (409) covers a stale or different selected ID; `PUBLIC_PD_MODEL_UNAVAILABLE` (409) covers an unavailable default. None dispatches an SD business request. Direct planner use with `selectedPdModelId` is rejected as `PUBLIC_PD_MODEL_VALIDATION_REQUIRED` (409). A missing callback is 503.

Focused SDK tests validate one successful request, unchanged search body/citations, selection receipt, and the rejection paths before transport. The public SDK test group passes 16/16; targeted strict TypeScript check for the native host provider and `git diff --check` pass. Production adapter/root wiring and the actual effective catalog/search request remain for the concentrated candidate; no runtime PASS is inferred.
