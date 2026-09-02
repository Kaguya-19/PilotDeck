# PilotDeck Desktop

Electron desktop shell for the existing PilotDeck Web UI and local gateway runtime.

## Development

```bash
pnpm install --frozen-lockfile
pnpm --filter pilotdeck-desktop dev
```

The desktop process starts the existing PilotDeck gateway and UI server as local
child processes, then opens the packaged Web UI inside an Electron window.

## Packaging

```bash
pnpm --filter pilotdeck-desktop dist:mac
pnpm --filter pilotdeck-desktop dist:win
```

Platform release builds should run on matching GitHub Actions runners:

- macOS universal DMG artifacts on `macos-latest`
- Windows x64 NSIS installer artifacts on `windows-latest`

macOS CI signs and notarizes release artifacts when the repository provides
these GitHub Secrets:

- `MACOS_DEVELOPER_ID_APPLICATION_P12_BASE64`: base64-encoded `.p12` for
  a valid `Developer ID Application` certificate.
- `MACOS_DEVELOPER_ID_APPLICATION_PASSWORD`: the `.p12` export password.
- `MACOS_KEYCHAIN_PASSWORD`: optional password for the temporary CI keychain.
- `APPLE_ID`: Apple account email used for notarization.
- `APPLE_APP_SPECIFIC_PASSWORD`: Apple app-specific password for notarization.
- `APPLE_TEAM_ID`: Apple Developer Team ID.

CI release builds fail closed when signing credentials are absent. Local macOS
development packages may still use ad-hoc signing.

The packaging script stages a production-only runtime in `.runtime/app` before
calling `electron-builder`; the final app should not include the workspace
development dependency tree.

See [`docs/desktop-release.md`](../../docs/desktop-release.md) for the daily
release policy, required GitHub Secrets, manual recovery, and Web deployment
compatibility guarantees.
