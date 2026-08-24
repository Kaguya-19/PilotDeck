# Telemetry Receiver Contract (`analytics.v2`)

客户端运行时契约见 [`../trd/50-telemetry-runtime.zh.md`](../trd/50-telemetry-runtime.zh.md)。

## Endpoint

- Method: `POST`
- Path: `/collect`
- Content-Type: `application/json`
- Body: `AnalyticsEvent[]`
- Success status: any `2xx`
- Deduplication key: `eventId`

## Delivery Semantics

- At-least-once delivery.
- Client batches events (default 20) and retries failed requests.
- Client persists unsent queue to local JSONL on shutdown and restores on startup.
- Receiver must handle duplicated events idempotently.

## Event Schema

```ts
type AnalyticsEvent = {
  schemaVersion: "analytics.v2";
  eventId: string;
  eventName: "feature_used" | "error_occurred";
  occurredAt: string; // ISO timestamp
  installationId: string; // installation-level identity (stable across shared server-token)
  instanceId: string; // instance-level identity (distinguishes multi-instance same machine)
  deploymentMode:
    | "source"
    | "docker"
    | "curl_installer"
    | "desktop_installer"
    | "npm_binary"
    | "unknown";
  sessionId?: string; // 24-char hex hash of internal sessionKey (not the raw key)
  commitHash: string; // app/runtime commit hash
  appVersion: string;
  platform: string; // process.platform
  properties: Record<string, unknown>;
};
```

## Breaking Change Notes

- `analytics.v2` adds explicit source attribution: `ownerModule`, `executionKind`, and `phase`.
- `module = "router"` now describes router/tokenSaver/judge/fallback health only; real provider requests are reported through `module = "session"` unless they belong to memory/judge direct LLM calls.
- `module = "session"` may include reused agent-loop executions for Always-On, subagents, compaction, or tool-secondary model calls. Use `ownerModule` and `executionKind` to isolate ordinary user sessions.
- Removed field: `projectCommitHash`.
- Removed field: `projectPath` (no filesystem paths in outbound events).
- `sessionId` is now a hashed anonymous id, not the raw `sessionKey` (which may embed paths).
- `error_occurred` no longer includes `message` or `stack`; only classification fields below.
- Removed event types: `app_started`, `session_active` (DAU uses any `feature_used` / `error_occurred`).

## `feature_used` Two-Layer Model

For `eventName = "feature_used"`, `properties` follows:

```ts
type FeatureUsedProperties = {
  /** Business surface being measured. */
  module: "router" | "always_on" | "memory" | "cron_job" | "session";
  /**
   * Business owner of an execution event. For ordinary user chat this is
   * "session"; for Always-On agent loops it is "always_on" even though
   * `module` remains "session".
   */
  ownerModule?: "router" | "always_on" | "memory" | "cron_job" | "session";
  executionKind?:
    | "user_session"
    | "subagent"
    | "always_on"
    | "router_judge"
    | "memory"
    | "cron_job"
    | "compaction"
    | "tool_secondary";
  /** Business phase, e.g. router judge/decision/fallback or Always-On discovery/workspace/execution/report/apply. */
  phase?: string;
  loopStage:
    | "module_event"
    | "loop_start"
    | "model_request"
    | "model_response"
    | "tool_prepare"
    | "tool_call"
    | "permission_check"
    | "loop_end";
  outcome?: "success" | "failed" | "aborted" | "timeout" | "denied";
  errorCategory?:
    | "model_request_error"
    | "permission_error"
    | "tool_param_error"
    | "tool_runtime_error"
    | "tool_result_parse_error"
    | "loop_error"
    | "runtime_error";
  provider?: string;
  model?: string;
  /** HTTP(S) API base from provider config (no userinfo, query, or fragment). */
  providerBaseUrl?: string;
  // plus other module-specific metadata (path-like keys stripped client-side)
  [key: string]: unknown;
};
```

Session `model_request` events are emitted after routing, when the real provider request starts (`model_event` → `request_started`), not at turn submit time.

Ordinary user chat should be queried as:

```sql
properties.module = 'session'
AND properties.ownerModule = 'session'
AND properties.executionKind = 'user_session'
```

Always-On reused agent-loop health should be queried as `module = 'session' AND ownerModule = 'always_on'`, grouped by `phase`.

## `error_occurred` Properties

- `module`: same module space as above plus runtime/ui contexts.
- `ownerModule`, `executionKind`, `phase`: same attribution semantics as `feature_used`.
- `loopStage`: where the error occurred.
- `errorCategory`: normalized category.
- `code`: error code (if available).

No `message`, `stack`, or caller-supplied metadata is included.

## Privacy

- Outbound events must not contain raw filesystem paths.
- Property keys matching path-like names (`path`, `cwd`, `root`, etc.) and absolute-path string values are stripped before upload.

## Aggregation Guidance

- Installation-level active users (DAU): distinct `installationId` per day with any event (`feature_used` or `error_occurred`).
- Instance-level active users: distinct `instanceId` per day.
- Module metrics: group by `properties.module`.
- Ordinary user session metrics: filter by `module=session + ownerModule=session + executionKind=user_session`.
- Loop-stage funnel/error rates: group by `properties.module + properties.loopStage + properties.outcome`.
- Session-scoped funnels: group by hashed `sessionId`.
