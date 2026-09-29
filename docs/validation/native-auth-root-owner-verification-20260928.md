# Native auth-root consumer verification

Integration already fixed the scoped production guard in clean PD `54224923fe05ead1e77f204fa179dcdd9a9d0c7c` (bootstrap profile isolation in parent `650d685c`). This public owner batch adds only a new consumer test and this evidence; it does not repeat or overwrite the shared startup implementation. SD remains `23d9319d2a813dd8b5d2e68b2165da253fd893ce` for the model/parser fix. Historical gate-only attempt2 and its raw remain unchanged.

The configuration correction is `pilotdeckAuthDatabasePath = <this-run PILOT_HOME>/auth.db` for the native default profile. Bootstrap environment, recorded auth root, enabled profile's effective `webui.runtime.databasePath` and enabled environment must resolve to the same file. `DATABASE_PATH` alone cannot redirect the native profile-derived path. An explicit alternative profile path is valid only if bootstrap and enabled effective config both name it before any database import; no file is moved or copied to make the receipt match.

The added `tests/composition/public-startup-native-auth-root.test.mjs` invokes `prepareMinimumStartup` then spawns a real Node process importing **the production `ui/server/load-env.js`**, through the existing tsx loader. It observes the actual resulting `process.env.DATABASE_PATH`; it does not substitute a mock config derivation. Four cases passed: default native home matches admission/receipt; attempt2's second-path configuration fails before receipt creation and native load-env independently explains the observed override; explicit bootstrap profile path matches; inherited profile is cleared and cannot redirect bootstrap. The probes import no database module and create no auth database/user/key. Temporary fixture inputs are removed after each test.

Command, with process-local preload reset and Node v22.23.1:

```sh
NODE_OPTIONS='' /Users/a1/.nvm/versions/node/v22.23.1/bin/node --test \
  tests/composition/public-startup-native-auth-root.test.mjs \
  scripts/run-minimum-staffdeck-startup.test.mjs \
  scripts/compose-limited-staffdeck-profile.test.mjs
```

Result: **15/15 passed** (4 new native consumer checks, 9 existing startup checks, 2 profile checks). Syntax and diff checks passed. Sanitized evidence is [native-auth-root-focused-evidence-20260928.json](native-auth-root-focused-evidence-20260928.json). This is focused source/consumer verification, not new runtime gate admission, stream evidence or business PASS. No full build or typecheck was necessary for the added JavaScript test.

## Remaining startup evidence

The original attempt2 failure is still `STARTUP_AUTH_DATABASE_REQUIRED`; its `state/auth.db` receipt cannot be silently rewritten as if it had always pointed to the observed native database. Integration must apply the corrected input/receipt policy while retaining the original failure and the same existing native account database. Any resumed authenticated process must use normal login of the already registered account: no additional registration, copying/moving database, changing key or disabling authentication. This batch did not restart that root or alter its state/raw.

Actual enabled PD/Gateway readiness, authenticated `describe`, unique available/default catalog matching the profile, real canonical model stream, fixed SD domain DI response and deployed selected Port remain **NOT RUN** since attempt2 stopped before them. They need the integration-authorized gate process after its auth receipt/input is reconciled explicitly. No Knowledge/SOP business is needed for these startup checks. Retain `code/detail/request_id` from any HTTP rejection; startup-only errors have no fabricated HTTP request ID.

No runtime-6/runtime-7 changes, old raw edits, model fallback, second model, push, merge, deploy or archive occurred.
