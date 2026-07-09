---
name: browser-use
description: "Use PilotDeck's browser-use plugin for browser automation, screenshots, form filling, and web UI checks."
---

# browser-use

Use this skill when a task needs browser automation through PilotDeck's built-in `browser-use` plugin, especially for local Web UI smoke tests, screenshots, navigation, clicking, typing, and DOM inspection.

## Availability

PilotDeck ships the `browser-use` plugin, which runs `@playwright/mcp` with Chromium. The plugin needs Chrome for Testing to be installed on the machine before browser automation can launch reliably.

Check whether the browser is already installed:

```bash
if ls "$HOME/Library/Caches/ms-playwright"/mcp-chrome-for-testing-* >/dev/null 2>&1 || \
   ls "$HOME/.cache/ms-playwright"/mcp-chrome-for-testing-* >/dev/null 2>&1; then
  echo "Chrome for Testing is already installed; no reinstall needed."
else
  echo "Chrome for Testing is not installed yet."
fi
```

The one-line installer uses the same check. If Chrome for Testing is already present, it prints `Chrome for Testing already installed` and does not download it again.

Install it from a PilotDeck source checkout or installed app directory:

```bash
cd /path/to/PilotDeck
corepack pnpm install --frozen-lockfile
corepack pnpm run install:browser
```

For an installed one-line setup, use the app directory shown by `pilotdeck status`:

```bash
pilotdeck status
cd ~/.pilotdeck/app
corepack pnpm run install:browser
```

To let the one-line installer install it during setup, opt in explicitly:

```bash
PILOTDECK_SKIP_BROWSER_INSTALL=0 bash install.sh
```

Repeated installs are safe: check first, skip when present, install only when missing.

If the download is slow or blocked, configure your network proxy first and rerun the install command. Browser automation is optional; PilotDeck core chat, files, skills, and settings work without it.

## Usage Notes

- Prefer browser-use for interactive browser tasks instead of trying to script raw HTTP requests.
- For local PilotDeck checks, open the URL shown by `pilotdeck status`, usually `http://localhost:3001`.
- If no model provider is configured, a clean PilotDeck instance should land on onboarding rather than settings or chat.
- Keep browser tasks small and observable: navigate, wait for a visible heading, inspect relevant text, then report evidence.
- Do not store API keys, session cookies, or private credentials in screenshots or logs.

## Common Checks

```text
Open http://localhost:3001
Verify the page shows LLM Provider Setup when no real provider config exists
Open Settings and verify provider/API key controls are visible
Take a screenshot only when visual evidence is useful
```
