# G4 Native AgentLoop Evidence

This evidence closes the native StaffDeck AgentLoop/Harness comparison for the shared G4 Knowledge fixture:

- tenant `tenant_demo`
- actor `admin`
- agent `agent_7d062081c03b4e16`
- initial fact `Native branch-only owner approval fact 7d062081c03b4e16`
- updated fact `Native branch updated security review fact 7d062081c03b4e16`
- ordinary question: "What is the current approval policy for a release decision, specifically what owner-approval fact applies before release?"

`native-mock.json` is deterministic Harness/permission evidence only. Its model intentionally returns empty document/bucket routing choices, so the Knowledge trace uses `document_route_lexical_fallback` and `bucket_route_lexical_fallback`. It is explicitly classified as `lexical_fallback`, not normal native model selection. It covers native Knowledge exposure, overreach denial, SOP submission, and both no-grant outcomes: the slash SOP is rejected before model invocation, while a normal non-slash question reaches the model with no Knowledge tool schema or call.

`native-real.json` records two real native model sessions using `provider1/qwen3.6-flash-distill`. The first ordinary question retrieves the initial fact. The runner then replaces the document through `KnowledgeService.replace_document_content`, resets the Harness runtime, and sends a second ordinary question with the same tenant, actor, and agent. The second session returns the updated fact with `[1]` and `ultrarag://knowledge/documents/kdoc_native_g4`; its serialized evidence and reply exclude the initial fact. Both sessions show native Knowledge tool calls, Knowledge evidence results, SOP submission, and final cited answers. Their route phases contain no fallback or failed selection phase and are classified as `normal_model_route`.

## Reproduction

Prerequisites:

- StaffDeck checkout with its backend environment and dependencies
- built Harness v3 checkout containing `apps/cli/lib/bin.js`
- Node 22.23.1 or newer, required by the Harness dependency's Zstd support
- `uv` and the StaffDeck backend project
- for real mode only, runtime environment variables `STAFFDECK_MODEL_BASE_URL` and `STAFFDECK_MODEL_API_KEY`; the key is never written to evidence

The runner requires these runtime variables and keeps all generated homes, data directories, and the SQLite database isolated and temporary:

```sh
env -u NODE_OPTIONS \
  STAFFDECK_ROOT=/path/to/StaffDeck \
  HARNESS_V3_ROOT=/path/to/deepseek-harness \
  HARNESS_V3_NODE_BIN=/path/to/node \
  STAFFDECK_NATIVE_MODE=mock \
  STAFFDECK_NATIVE_V3_OUT=conformance/artifacts/g4-native-agentloop-20260923/native-mock.json \
  uv run --project /path/to/StaffDeck/backend \
  python conformance/run_staffdeck_native_g4_knowledge.py
```

For the real comparison, set `STAFFDECK_NATIVE_MODE=real`, `STAFFDECK_MODEL_BASE_URL`, `STAFFDECK_MODEL_API_KEY`, and `STAFFDECK_MODEL_NAME=qwen3.6-flash-distill`, and change the output path to `native-real.json`. The runner uses ports in `16100-16129`, removes only resources it created, and records cleanup status in each artifact.

The companion Gateway composition test accepts `PILOTDECK_E2E_PORT_RANGE=16400-16429` (or the validated `PILOTDECK_E2E_PORT_START` and `PILOTDECK_E2E_PORT_END` pair); its default remains `16100-16129`. With `PILOTDECK_E2E_ARTIFACT_DIR` set, it writes `port-cleanup.json` containing the allocated ports, closed ports, active-port set, and `cleanupComplete` assertion.
