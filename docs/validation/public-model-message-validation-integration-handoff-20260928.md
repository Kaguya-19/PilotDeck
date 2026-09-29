# Integration handoff for `ab35cdcc5` (2026-09-28)

## Fixed ref

Consume commit `ab35cdcc5a0b6bab19448f6dc64525c40df5d998`:

```text
fix(public): reject malformed model messages at host port
```

The commit changes only the active public model Port, its focused test, and
the delivery receipt:

```text
src/composition/activeRuntimeModelPorts.ts
tests/composition/activeRuntimeModelPorts.test.ts
docs/validation/public-model-message-validation-delivery-20260928.md
```

The integration owner may cherry-pick this commit into the fixed integration
branch. Do not include unrelated dirty files from the source worktree.

## Focused verification already completed

These commands were run with the workspace Node 22 runtime:

```bash
PATH=/Users/a1/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH \
  ./node_modules/.bin/tsx --test tests/composition/activeRuntimeModelPorts.test.ts
# 4/4 passed

PATH=/Users/a1/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH \
  ./node_modules/.bin/tsc -p tsconfig.json --noEmit --pretty false
# passed

git diff HEAD^ HEAD --check
# passed
```

The focused test proves that string content, empty content, and an empty
`messages` array return `400 invalid_request` before `runtime.model.stream` is
called. It does not prove a real provider turn or any G0–G7 gate.

## Boundary for the integrator

The fix is at `createActiveRuntimeModelPorts`, which is the production public
runtime path used by the fresh Gateway model callback. Internal
`buildModelRequest` compatibility for historical malformed messages is
unchanged. The separate native capability provider still calls the shared
core validator directly; do not claim this commit strictens that path unless a
separately owned change is made and tested.

Do not rerun Fresh4/Fresh5 business flows as part of consuming this ref. Keep
the Fresh4 provider-error raw artifact and Fresh5 K3/P3 raw artifacts as
historical evidence; a focused PASS cannot be promoted to a runtime PASS.
