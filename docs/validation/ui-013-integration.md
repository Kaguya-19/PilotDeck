# UI 0.1.13 integration receipt

Accepted UI PD commit d77691aff6d2b5d54ad217924ceccff50428c6a9, parent ce837699722e15fbada24bd9c7b5ece030d03612: only the new StaffDeckLocaleBoundary actual DOM/Portal test. 1/1 PASS using this tree's own locked pnpm installation. Raw log: /Users/a1/Documents/Codex/2026-09-27/g0-g6-integration-intake/ui-wip-handoff/ui-d77691af-integrated-tests.log. Original fixed patch: ui-pd-d77691af.commit.patch in the same directory.

Canonical shared source is SD0fa53ce38bef3e4547cd85b88142a7cc1528ec52, integrating UI32b87446 with native Input/Textarea forwarded refs and version-detail user boundaries. All 40 shared source files remain byte-identical. Shared package already declares tailwind-merge ^3.6.0; this host's frozen lock resolves tailwind-merge 3.6.0, with no new package/lock changes required for the receipt. Server bridge, adapter/context and private host files remain preserved.

SD actual consumers passed 7/7; PD Portal passed 1/1. These are focused component checks only. Full build/typecheck, D01–D07/C03/C04, business/browser matrix, pending whitelist/cancel and runtime effective observations are not promoted. No 674821da follow-up was imported in this receipt, no new candidate/round, push/merge or deployment.

## Presentation follow-up674821da consumer synchronization

Canonical SD06a8c9e7ad72190fe2fceea1f98b41ea513bc2ae incorporates674821dadab8344a02a199de02bfed31578def8d. Prior exclusion of that follow-up is historical and superseded here. FormalHostPrimitives and FormalCapabilityScopeControl are synced byte-for-byte; PD's existing export-star tooltip barrel and spread Primitive factory already supply TooltipProvider. No extra App/global Provider is required. Common scope normalization remains canonical and untouched.

The UI-owned mechanical PD Progress port still carried the exact source missing-value defect; only the source value={value} hunk is synchronized into it, retaining PD import/style/props. This is source-port maintenance through integration, not a separate primitive implementation or ownership reassignment. The public integration patch is available for its original UI owner to adopt.

Actual PilotDeck Knowledge Host injection3/3 PASS: source StatCard; Progress aria/value/indicator; standalone Scope/loading/switch with no App TooltipProvider; Paginator current/padZero/ellipsis/next. Log: /Users/a1/Documents/Codex/2026-09-27/g0-g6-integration-intake/ui-wip-handoff/ui-674821da-pd-consumer-tests.log. SD new presentation3/3 PASS separately. All40 canonical sources byte-identical, diff check PASS. No adapter/catalog/core/lock/server change; complete D01–D07/C04 and full builds/browser/business gates remain unapproved.
