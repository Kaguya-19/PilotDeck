# StaffDeck plaza copy bridge (PilotDeck WebUI)

The shared Knowledge and SOP pages retain their StaffDeck copy workflow. This
WebUI-only bridge does not add an eighth runtime owner or change Knowledge/SOP
module state. It calls StaffDeck's formal enterprise API with a server-held
token for the actual StaffDeck user. The PilotDeck browser token is never sent
to StaffDeck, and the StaffDeck token is never returned to the browser.

## Operation boundary

Previously public PilotDeck operations were Knowledge `list_bases` and
`sync_base`, plus SOP management `list` scoped to one configured agent. They
do not supply an authenticated visible agent directory, an overall SOP source
list, or the formal two-scope resource import.

`staffdeck.enterprise-copy/v1` exposes only these WebUI operations through
`POST /api/modules/staffdeck-copy/call`:

| Operation | StaffDeck formal request | Input from browser |
| --- | --- | --- |
| `list_agents` | `GET /api/enterprise/agents?tenant_id=<bound>` | none |
| `list_knowledge_bases` | `GET /api/enterprise/knowledge-bases?tenant_id=<bound>&agent_id=<visible-source>` | `sourceAgentId` |
| `list_skills` | `GET /api/enterprise/agents/<visible-source>/skills?tenant_id=<bound>` | `sourceAgentId` |
| `import_resources` | `POST /api/enterprise/agents/<bound-target>/resources/import` | `targetAgentId`, `sourceAgentId`, `resourceType`, `resourceIds` |

The bridge admits only an authenticated PilotDeck user whose ID equals the
configured `pilotDeckUserId`. Before every operation it calls StaffDeck's
formal `GET /api/auth/me` with the server-held token and requires its returned
`id` and `tenant_id` to equal the configured `actorUserId` and `tenantId`.
Missing PilotDeck or StaffDeck user binding is a 501 configuration error;
an authenticated PilotDeck user who differs from a configured binding is
rejected with 403.
This uses StaffDeck's normal `get_current_user`/control-provider authentication,
not local token decoding. An expired credential, disabled user, or identity
mismatch fails before reading the directory or copying. Redirects are not
followed with the user credential. If a Knowledge or SOP management binding
already declares an agent ID, it must equal the copy target. StaffDeck's
authenticated directory must include the configured non-overall target. Every
source must be in that same visible
directory; `import_resources` also requires the browser target to equal the
configured target. Tenant ID, destination path and StaffDeck bearer token come
only from server configuration. StaffDeck performs the authoritative source,
target, resource visibility, version-copy and write-permission checks. Its
403/404 responses are not converted into successful copy results. The
`PILOTDECK_MODULE_ADMIN=0` setting also disables this bridge's writes.

The returned `is_overall` is the actual directory value. `active` is derived
only from the returned `status`, and `copy_target` identifies the configured
target row without granting server permission. `can_manage` is true only when
the formal directory explicitly returns `metadata.directory_access.can_manage`
for that row; PilotDeck's local admin flag is not treated as StaffDeck
authorization. No `overall` ID or resource is synthesized by PilotDeck.

## Configuration

The native-five StaffDeck profile declares `webui.staffdeckCopy`; `webui` is
the reserved WebUI namespace and is not exposed by `/api/modules/runtime`.
Set these variables in the PilotDeck WebUI server environment before starting
the formal page:

- `STAFFDECK_FORMAL_API_ORIGIN`: StaffDeck formal backend origin, not the
  Knowledge module endpoint or SOP management endpoint.
- `STAFFDECK_COPY_TENANT_ID`: tenant of the StaffDeck user token.
- `STAFFDECK_COPY_ACTOR_USER_ID`: user ID returned by the formal StaffDeck
  `GET /api/auth/me` for that token.
- `STAFFDECK_COPY_TARGET_AGENT_ID`: existing employee managed by that user.
- `STAFFDECK_COPY_PILOTDECK_USER_ID`: actual authenticated PilotDeck user ID
  authorized to use this binding.
- `STAFFDECK_COPY_USER_TOKEN`: StaffDeck formal user bearer token issued for
  that user. This token remains exclusive to copy and account-credential
  identity checks; it is not a SOP management API key.

The same profile binds SOP management to that target with
`STAFFDECK_SOP_MANAGEMENT_ENDPOINT` (the same StaffDeck origin, `/api/v1`),
`STAFFDECK_SOP_MANAGEMENT_API_KEY` (server-held account key), and
`STAFFDECK_SOP_MANAGEMENT_CREDENTIAL_ID` (the ID returned at formal issuance).
Sign in as the configured StaffDeck actor and use
`POST /api/auth/me/api-credentials` to issue the key. The current formal
profile only issues `user_full_access`, including `sops:read`, `sops:write`,
and `sops:publish`; it does not issue a narrower SOP-only account key.
Keep the issued key in the PD server environment, never in the browser or
profile file. Renew the user token separately; rotate or revoke the account
key through the formal account-credential routes and update its server value.

Before each SOP management status or call, PD verifies the authenticated PD
user, the configured copy actor/tenant/target, and `GET /api/auth/me` using
the copy user token. It then calls `GET /api/auth/me/api-credentials` as that
actor and requires the configured credential ID, unique key prefix, active
status, expiry, account access profile, and SOP scopes to match the server-held
management key. This is the formal issuance/list record linking the key to
the actor, not a claim that `/api/auth/me` authenticates the API key. Each
actual SOP request uses the full API key and is separately verified by
StaffDeck's public API credential digest, status, expiry, actor permissions,
agent scope, and ETag/version checks. PD exposes only the ten named management
operations for the fixed target; no arbitrary public-API proxy or native SOP
owner fallback is provided. The runtime agent key and Knowledge copy user
token remain distinct from this account key.

An absent, expired, or mismatched identity fails explicitly. Do not replace
it with a client-provided tenant, a guessed overall ID, or a silent empty
directory. The bridge needs a renewed formal user credential when the token
expires; no automatic privilege escalation or token minting is implemented.

Contract tests exercise formal identity preflight, directory projection, both
source reads, both resource types, scope rejection, redirects and upstream
failure. They do not establish a real dual-host browser or StaffDeck
persistence PASS; independent G4 evidence must
still cover the actual UI, HTTP response and stored result.
