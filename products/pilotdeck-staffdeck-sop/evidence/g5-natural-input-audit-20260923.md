# G5 Natural-Input Audit (2026-09-23)

This artifact separates the prior guided closure from the ordinary-request
verification required for G5. It does not claim acceptance.

## Published Input

- StaffDeck public API created, validated, and published the SOP through the
  isolated service on port `16224`.
- Published binding: `skill_id=project_delivery_plan`, `version=1.0.1`.
- The deployment definition consumed by PilotDeck was the flat published SOP
  object extracted from the publish response. The full response and the flat
  object are versioned as `g5-publish-response-project-delivery-plan-1.0.1.json`
  and `g5-published-project-delivery-plan-1.0.1.json`.
- The earlier static `1.2.1` filename is not the source of this binding.

## Auxiliary Guided Trace

`/tmp/g5-full-repro-rerun-20260923-140951/g5-full-trace-2.json` records a
complete lifecycle, but its user messages explicitly named internal proposal
states, slot submission, and a branch transition. It is retained as auxiliary
diagnostic evidence only and is not a natural-entry G5 result.

## Isolated Startup

The reproducible service topology was:

```text
lifecycle adapter: 127.0.0.1:16205
discovery StaffDeck API: 127.0.0.1:16224
database: fresh isolated SQLite file
APP_SECRET: one ephemeral value shared by initialization and service startup
model: provider1/qwen3.6-flash-distill from /Users/a1/.pilotdeck
```

Credentials are intentionally omitted. The runner records redacted request,
response, timeout, and elapsed-time fields.

## Ordinary-Request Verification

The runner now sends only ordinary project-delivery language. It rejects its
own input if it contains internal status names, slot field names, transition
keys, or SOP node identifiers.

Runner:

```text
products/pilotdeck-staffdeck-sop/evidence/g5-agentloop-natural-discovery-run.mjs
```

The ordinary-request run reached discovery HTTP 200, selected
`project_delivery_plan@1.0.1`, executed `read_file`, and made lifecycle
prepare/submit calls. The pre-fix complete redacted failure trace is versioned
at `g5-natural-input-failure-20260923.json` with a compact summary beside it.

## Adapter Fix And Recheck

The failure was confirmed as two generic glue omissions. The StaffDeck adapter
reduced outgoing graph edges to IDs, dropping each edge's condition, priority,
label, and target-node context. PilotDeck also did not tell the model to place
already-known required information into `slotUpdates` and advance, or to choose
the condition-matching transition. The fix adds an additive `transitions` field
to the existing v2 step payload and renders generic slot/transition guidance;
owner validation and wait semantics are unchanged.

The same ordinary request then completed the full chain. The post-fix redacted
trace is `g5-natural-input-success-20260923.json`, with summary
`g5-natural-input-success-20260923.summary.json`: discovery 200, `read_file`,
prepare/submit, handoff, reload-preserved wait, human resume, duplicate replay,
and terminal `completed`.

This scenario is now **PASS after the generic adapter fix**. Final G5/domain
acceptance is still withheld pending the remaining domain matrix and separate
independent acceptance review.
