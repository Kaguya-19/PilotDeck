# Public model message validation delivery (2026-09-28)

## Scope

The public active model Port now rejects malformed canonical messages before
calling the selected runtime. `messages` must be a non-empty array; each
message must use the `user` or `assistant` role and a non-empty canonical
content-block array; every block must have a known canonical type. Rejection
uses `invalid_request` and therefore maps to HTTP 400 through the public host
adapter. Internal request builders retain their historical malformed-message
compatibility behavior.

Changed files:

- `src/composition/activeRuntimeModelPorts.ts`
- `tests/composition/activeRuntimeModelPorts.test.ts`

## Evidence

- Focused active Port suite: **4/4 passed**.
- TypeScript strict no-emit check: **passed**.
- `git diff --check`: **passed**.
- The new regression covers string content, empty content, and empty
  `messages`; all return `400 invalid_request` and the runtime stream is not
  called.

## Runtime owner handoff

Fresh4's retained provider 400 (`messages` too short) came from the malformed
probe sending `content: "..."`. `messageContent()` intentionally maps
non-array content to `[]`; the OpenAI builder then emitted `messages: []`.
The public boundary now rejects that input. The retained raw artifact is
`/Users/a1/Documents/Codex/2026-09-28/g0-g7-independent-runtime-4/raw/model-catalog-stream-success.json`.

Fresh5 K3 and P3 remain outside this adapter change. K3's first normal
Knowledge turn received HTTP 503 from StaffDeck `/api/v1/agents/{agent}/sops:route`;
the SD route currently maps any `PilotDeckDomainHostClient` runtime error to
503, so the public/SD owner must preserve the original cause while fixing the
route contract. P3 reached the route but StaffDeck SOP runtime manifest lookup
called `/healthz` and received 404. The configured full StaffDeck API does not
expose the required `sop.lifecycle/v2` manifest there; the SD/SOP runtime owner
must provide the real manifest endpoint or bind a separate SOP runtime. A
health status endpoint cannot substitute for the manifest contract.

No Fresh5 business rerun, fallback, second model, service/config change, or
acceptance status upgrade is part of this delivery.
