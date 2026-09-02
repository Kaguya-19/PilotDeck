# Desktop build and release

PilotDeck keeps Web and desktop sources on `main`. The desktop application is a
thin Electron shell around the same gateway and Web UI; desktop-specific runtime
behavior is enabled only when Electron sets `PILOTDECK_DESKTOP=1`.

## Web compatibility

- The existing root and `ui` build commands remain the source of the Web build.
- Docker installs only the root and UI workspace dependencies, so Electron and
  its native packaging dependencies are not installed in the Web image.
- Browser deployments never receive the Electron preload bridge.
- Desktop runtime files live under `apps/desktop` and are ignored by the Docker
  build context.

Pull requests that touch shared, UI, Docker, or desktop code run the Web
regression workflow. Desktop-related pull requests also compile and test the
desktop shell.

The Web test job temporarily excludes `ui/e2e/**` (Playwright tests are not
Vitest tests) and the upstream `streamSmoother.test.ts` fake-timer test. Both are
known baseline failures; all other UI/server tests remain in the merge gate.

## Daily release policy

`.github/workflows/desktop-release.yml` runs every day at 02:00 Asia/Shanghai
(18:00 UTC on the previous calendar day). It compares `main` with the commit in
the latest desktop release tag:

- no production change: skip the release;
- production change: build a signed and notarized macOS installer plus an
  unsigned Windows installer, then publish one dated GitHub Release;
- repeated manual release on the same date: use `-r2`, `-r3`, and so on.

Release tags are `desktop-vYYYY.MM.DD`. The internal Electron version is a
numeric SemVer derived from the same Shanghai date. GitHub Actions may also be
started manually with an optional release revision.

Every release contains the DMG, Windows installer, `desktop-release.json`, and
`SHA256SUMS`. The desktop updater ignores unrelated Web/server releases and only
considers tags beginning with `desktop-v`.

## Required GitHub Secrets

Release builds deliberately fail when macOS code signing or notarization is
unavailable. Windows packaging remains explicitly unsigned, matching the
existing `desktopdev` release behavior.

macOS:

- `MACOS_DEVELOPER_ID_APPLICATION_P12_BASE64`
- `MACOS_DEVELOPER_ID_APPLICATION_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`
- `MACOS_KEYCHAIN_PASSWORD` (optional)

The macOS universal job runs on GitHub's Apple Silicon `macos-latest` image and
fails early if the host architecture is not arm64. This is required so both
arm64 and Rosetta/x64 native dependencies are installed and tested.

The macOS certificate must be a Developer ID Application certificate. The
Windows installer does not require a signing certificate. GitHub's automatic
`GITHUB_TOKEN` is used to publish the Release.

## Manual builds

```bash
pnpm install --frozen-lockfile
pnpm --filter pilotdeck-desktop test
pnpm --filter pilotdeck-desktop dist:mac
# Run the following on Windows:
pnpm --filter pilotdeck-desktop dist:win
```

Local macOS builds can use ad-hoc signing. Set
`PILOTDECK_DESKTOP_REQUIRE_SIGNING=1` to enforce production signing locally.

## Recovery

If one platform fails, fix the credential or build issue and rerun the failed
workflow. A release is created only after both signed platform artifacts are
downloaded and verified. For a deliberate second release on the same Shanghai
date, run the daily workflow manually and set revision `2` or higher.
