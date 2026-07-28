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

- macOS DMG artifacts on `macos-latest`
- Windows NSIS installer artifacts on `windows-latest`

macOS CI signs release artifacts when the repository provides these GitHub
Secrets:

- `MACOS_DEVELOPER_ID_APPLICATION_P12_BASE64`: base64-encoded `.p12` for
  `Developer ID Application: Beijing ModelBest Technology Co., Ltd. (77Y5JFSH6H)`.
- `MACOS_DEVELOPER_ID_APPLICATION_PASSWORD`: the `.p12` export password.
- `MACOS_KEYCHAIN_PASSWORD`: optional password for the temporary CI keychain.

If the certificate secret is not configured, macOS packaging falls back to the
existing ad-hoc signing path. Apple notarization and Windows Authenticode
signing remain separate hardening steps.

The packaging script stages a production-only runtime in `.runtime/app` before
calling `electron-builder`; the final app should not include the workspace
development dependency tree.
