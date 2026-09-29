# Fresh3 SOP route: PD active model Port delivery

Fresh3 first failed before any model call: SD public `sops:route` used `model_for_agent` and returned 409 with no SD tenant model. This change makes the PD discovery client request an explicit `model_source: "pilotdeck_host"`. The original SD native source remains available only when expressly selected; a PD host failure never falls back to it. Fresh3 raw remains the first failure, and no business rerun is claimed here.

## Wire and owner boundary

PD `StaffDeckSopDiscoveryClient.route` sends the original message/session/active SOP/step/slots/pending/wait fields plus `model_source`. Its public credential still authenticates the existing SD route `POST /api/v1/agents/{target}/sops:route` with `sops:read`. SD still applies `enforce_agent_access`, `ensure_public_agent`, published SOP visibility, `expand_visible_sops`, and `discoverable_sops` before model execution.

The selected PD branch uses the existing server-only `PilotDeckDomainHostClient` and its authenticated Gateway `POST /api/module-host/call` transport. It sends the bound `{pilotDeckUserId,tenantId,actorUserId,agentId}` principal and calls exactly:

1. `list_model_catalog` with `{}`; require exactly one available canonical `provider/model`, matching `defaultSelection` or `is_default`. This is the current one-model minimum profile. Multiple available models fail before streaming because a catalog default alone cannot prove the active turn's session override. No caller model ID, SD `ModelConfig`, or fallback selection.
2. `model_stream` with `{requestId,modelId:"provider/model",request:{provider,model,systemPrompt,messages,stream:true}}`. The prompt is produced by SD's original `TurnPlanner.prepare_payload`, `_prepare_user_input`, `_request_messages` and JSON-mode instruction, then translated to canonical PD text messages. The response must be NDJSON canonical `text_delta` and a `message_end` with `finishReason:"stop"`; an error, incomplete stream, unsupported prompt content, bad JSON or invalid schema fails explicitly. SD applies the original `TurnPlanner._generate_validated_plan` schema repair and `normalize_plan` to the returned plan. Selected SOP IDs and candidate IDs remain computed from the original visible snapshots.

The PD native host catalog now uses canonical IDs in its descriptors and resolves those exact IDs back to the existing provider/model object for streaming. The active runtime Port and Gateway model catalog are the same PD model source.

## Minimal production DI hunk for the integration owner

In the existing SD startup composition root, after its normal env/profile loading and before serving the public API, call the public owner export:

```python
bind_pilotdeck_domain_host_from_runtime(
    gateway_url=<current PILOTDECK_GATEWAY_URL>,
    token_path=<current PILOTDECK_GATEWAY_TOKEN_PATH / server-token path>,
    pilotdeck_user_id=<verified current PILOTDECK_USER_ID>,
)
```

The factory reads the existing Gateway token file, maps its `ws(s)` URL to the same origin's `http(s)` Port, and binds the server-only client. The integration owner must use the current fixed target/identity tuple and active Gateway root; it must not mint a new token or construct a second model runtime. The current Gateway host provider must declare and serve `list_model_catalog` and `model_stream` through `/api/module-host/call`; an absent declaration produces a visible failure. No `modules.js`, Gateway/root, SD `main.py`, PEP, AgentLoop or DB model hunk is in these commits.

The adapter has no browser hunk: SOP discovery is a server-side PD client. Its input/output is the existing `StaffDeckSopRouteResult`; a non-2xx response remains a discovery error. The SD route returns 503 `PUBLIC_HOST_SOP_ROUTE_UNAVAILABLE` for missing binding or model Port failures, with no SD model lookup in the `pilotdeck_host` branch.

## Focused evidence and limits

SD route/host callback/ingest compatibility tests: 14 passed, including an actual route-to-MockTransport chain and missing/multiple-model failures. PD native provider/catalog/stream and discovery-client tests: 2 passed; targeted strict TypeScript and SD syntax checks passed. A separate broader PD discovery-routing spec currently fails with `SOP_STEP_RESULT_REQUIRED` after a mocked route response; it does not exercise this new Gateway callback or the fresh3 409. It remains a test failure to review in the concentrated candidate. This delivery does not assert an effective SD startup binding, real model stream, business completion, or gate PASS.
