# Minimum Knowledge read: public module delivery (2026-09-28)

This delivery closes the normal `knowledge_query` route's authenticated read contract for the fixed target. It does not record a live model or Knowledge acceptance run.

## Fixed wire contract

The StaffDeck public app is mounted at `/api/v1` on `STAFFDECK_PUBLIC_ORIGIN`.

- `GET /api/v1/knowledge-module/module-manifest` advertises `staffdeck.knowledge/v1`, `module-http-v2`, and only `query`.
- `POST /api/v1/agents/{fixed_agent_id}/knowledge-module/v2/module/call` requires `Authorization: Bearer <account public credential>` with `knowledge:read`. The account credential is read by the PD server from `STAFFDECK_KNOWLEDGE_READ_KEY` for each call; it is never placed in the profile or browser module binding.
- The request is the existing module v2 `module_call` envelope with `module: "knowledge"`, `payload.operation: "query"`, and input `query` plus supported Knowledge search filters and budgets. `tenant_id` and actor come only from the verified public principal; target comes only from the URL. Caller identity and SD model selection fields are rejected. The original public Knowledge PEP checks the target and viewer access; native Knowledge search applies visible version and resource PEP. The request-local public host selection uses lexical retrieval and leaves PD's selected model as dialogue owner.
- A successful response is a correlated module v2 response with `payload.result` equal to `KnowledgeSearchResponse`, including chunks and citations. PEP and input errors use the module failure envelope with their HTTP status and code. Missing or revoked account credentials fail at authentication; PD refuses a missing server credential before sending a business call.

The configured route is intentionally distinct from the old unauthenticated `/v2/module/call`. The parser rejects a credential-bearing Knowledge binding to that old route or to a target other than its declared `agentId`. The actual PD session registers `knowledge_query` through `createKnowledgeModulePort` using this binding.

## Enabled profile preparation

`products/pilotdeck-staffdeck-sop/profiles/render-limited-20260928.mjs` writes one enabled JSON profile with PD native agent loop, tools, skills, context and model provider; SD Knowledge `query`; and the published SOP bundle binding. It requires these real deployment inputs before rendering:

| Environment input | Meaning |
| --- | --- |
| `PILOTDECK_REAL_MODEL_PROVIDER_ID`, `PILOTDECK_REAL_MODEL_ID`, `PILOTDECK_REAL_MODEL_BASE_URL`, `PILOTDECK_REAL_MODEL_API_KEY` | Selected PD model and its real provider endpoint/credential. The output references the API-key environment variable, not its value. |
| `STAFFDECK_PUBLIC_ORIGIN`, `STAFFDECK_KNOWLEDGE_READ_KEY`, `STAFFDECK_FIXED_TARGET_AGENT_ID` | Reachable SD public app, already issued account credential with `knowledge:read`, and its authorized fixed target. |
| `STAFFDECK_SOP_RUNTIME_ORIGIN`, `STAFFDECK_PUBLISHED_SOP_BUNDLE_PATH`, `STAFFDECK_PUBLISHED_SOP_ID` | Reachable SOP runtime and an existing published bundle and matching published SOP ID. |

With those variables set in the Gateway server process, run `node products/pilotdeck-staffdeck-sop/profiles/render-limited-20260928.mjs /path/to/limited-pilotdeck.json` and set `PILOTDECK_CONFIG_PATH` to that output for the same process. The renderer refuses missing inputs and output overwrite; it sets mode `0600`. The Gateway must load the resulting profile and confirm the selected model, target, manifest, and SOP binding at startup. A generated test fixture or `reload_config` alone is not evidence that the production process selected it.

## Integration and evidence boundary

The integration owner applies the fixed StaffDeck and PilotDeck commits to the concentrated pair and supplies the real account credential, public origin, model binding and published SOP bundle through the production composition root. There is no `modules.js` change in this delivery. Verify `GET` manifest identity, an authorized `POST` from the normal PD `knowledge_query` tool, a citation from the ingested fixed-target document, and a negative wrong-target/insufficient-scope call on the actual process. The independent candidate run owns those results; no runtime/model/Knowledge PASS is claimed here.

Focused checks in the isolated trees: StaffDeck public-read tests `3 passed`; PilotDeck transport/profile tests `4 passed`; targeted TypeScript strict no-emit and `git diff --check` passed. Both tests use local fixtures or dependency overrides, not an effective production profile.
