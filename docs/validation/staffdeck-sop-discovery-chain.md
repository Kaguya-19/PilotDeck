# StaffDeck SOP Discovery Chain

This runner is versioned with the PilotDeck SOP integration. It exercises the final protocol path:

`StaffDeck TurnPlanner -> POST /api/v1/agents/{agent_id}/sops:route -> PilotDeck session submit -> SOP prepare -> native tool/prompt surface`

The runner never contains a credential, never selects an SOP from a local message-to-ID map, and never starts a model mock. The StaffDeck database must already point at the provider under test. The local runtime client is only a protocol fixture for the SOP prepare lifecycle; routing remains owned by StaffDeck's `TurnPlanner`.

## Prerequisites

- StaffDeck final checkout with commit `2608a8c2`.
- PilotDeck final checkout with commit `9027b272` and a completed `pnpm run build`.
- An isolated StaffDeck SQLite database with an enabled default model and published purchase/compare SOPs.
- A built Harness v3 checkout for `HARNESS_V3_ROOT`.
- A short-lived API credential exported through `STAFFDECK_SOP_API_KEY_ENV`; the value is never written to reports.

All paths and ports are parameters. The launcher defaults to `APP_PORT=16223` only as a convenience. The model endpoint and provider are read from the isolated database, not hardcoded by this runner.

## Run Against A Real Provider

Configure the isolated database's default model with the real provider before starting the app. Do not set a local deterministic model endpoint and call its output real-provider evidence. Then run:

```bash
export STAFFDECK_ROOT=/path/to/StaffDeck-g5-sop-agent
export PILOTDECK_ROOT=/path/to/PilotDeck-g5-sop-agent
export HARNESS_V3_ROOT=/path/to/built-harness-v3
export DATABASE_URL=sqlite:////tmp/staffdeck-sop-real.sqlite3
export APP_SECRET='isolated-secret'
export STAFFDECK_SOP_API_KEY='sd_live_...'
export APP_PORT=16223
export OUTPUT=/tmp/staffdeck-sop-discovery-chain.json

"$STAFFDECK_ROOT/tools/run-sop-discovery-chain.sh"
```

The launcher starts only StaffDeck, waits for its HTTP root, runs the PilotDeck script, and cleans up the app and temporary Harness home. Existing services are not touched. Use `STAFFDECK_URL`, `STAFFDECK_AGENT_ID`, `PILOTDECK_BUNDLE`, `NODE_BIN`, and `HARNESS_V3_HOME` to override defaults.

Direct runner usage is supported when StaffDeck is already running:

```bash
STAFFDECK_SOP_API_KEY='sd_live_...' \
node "$PILOTDECK_ROOT/scripts/staffdeck-sop-discovery-chain.mjs" \
  --staffdeck-url http://127.0.0.1:16223 \
  --agent-id agent_tenant_demo_overall \
  --bundle "$PILOTDECK_ROOT/fixtures/staffdeck-sop-discovery-bundle.json" \
  --output /tmp/staffdeck-sop-discovery-chain.json
```

The purchase and compare messages are parameters (`--purchase-message`, `--compare-message`). A successful report must show distinct selected SOP IDs and `prepare` lifecycle records for both sessions. The ordinary request must have neither `submit_step_result` nor `<staffdeck-sop>`.

The completed real-provider evidence in this task was produced from `/Users/a1/.pilotdeck/pilotdeck.yaml`, provider `provider1/qwen3.6-flash-distill`, copied into an isolated StaffDeck database with a matching isolated `APP_SECRET`. See `evidence/g5-agentloop-real-config-run.json`; the credential itself is not present in that file.

## No-Credential Evidence

When the credential environment variable is absent, the runner exits `2` and writes only this shape to the requested output:

```json
{
  "status": "BLOCKED",
  "reason": "missing_api_key",
  "apiKeyEnv": "STAFFDECK_SOP_API_KEY"
}
```

This is an environment limitation, not a routing pass. A report with `mode: live-staffdeck-discovery` is valid real-provider evidence only when the configured StaffDeck model is the provider being evaluated. Local deterministic model services must be reported separately as protocol-only validation.
