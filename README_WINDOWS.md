# PilotDeck Windows Deployment Guide

This guide covers source-based deployment on Windows. The one-line installer in the main README targets macOS/Linux only; on Windows, choose one of the paths below.

## Recommended Paths

- **WSL2 Ubuntu**: recommended for source deployment. It matches the Linux toolchain used by the Docker image and avoids most native npm build issues.
- **Docker Desktop**: recommended if you only need to run PilotDeck locally and do not want to manage Node/native build tools yourself.
- **Native Windows**: possible, but requires Node.js, Git LFS, Python, Visual Studio C++ build tools, and a few CLI utilities.
- **Portable Node**: verified on Windows without system Node/npm, Docker, or WSL2; useful for testing before installing Node globally.

## Contents

- [Fresh Windows Prerequisites](#fresh-windows-prerequisites)
- [Option A: WSL2 Ubuntu (Recommended)](#option-a-wsl2-ubuntu-recommended)
- [Option B: Docker Desktop](#option-b-docker-desktop)
- [Option C: Native Windows](#option-c-native-windows)
- [Verified Portable Node Path](#verified-portable-node-path)
- [Troubleshooting](#troubleshooting)

## Fresh Windows Prerequisites

Start here if this is a clean Windows machine or if commands such as `node`, `npm`, `python`, `docker`, or `wsl` are not recognized.

### Choose one deployment path first

| Path | Install on Windows | Best for |
|---|---|---|
| WSL2 Ubuntu | WSL2, Ubuntu, Git for Windows, then Linux build tools inside Ubuntu | Source deployment and development |
| Docker Desktop | Docker Desktop with WSL2 backend, Git for Windows | Running PilotDeck without local Node/native build setup |
| Native Windows | Node.js, Git LFS, Python, Visual Studio Build Tools, ripgrep | PowerShell-only development |
| Portable Node | Official Node.js zip, Git for Windows, Git LFS, ripgrep | Verifying deployment without changing system Node settings |

You do **not** need to install every item for every path. For example, Docker Desktop does not require local `npm install`, while native Windows does not require Docker.

### Quick prerequisite check

Run this in PowerShell before starting native Windows or Docker setup:

```powershell
node --version
npm --version
git --version
git lfs version
python --version
rg --version
docker --version
docker compose version
wsl --status
```

Missing commands mean the corresponding tool still needs to be installed or added to `PATH`. After installing tools, close and reopen PowerShell before checking again.

### Install tools with winget (Native Windows)

If `winget` is available, this is the fastest way to install most native Windows prerequisites:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
winget install GitHub.GitLFS
winget install Python.Python.3.12
winget install BurntSushi.ripgrep.MSVC
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

Then open a new PowerShell window and run:

```powershell
git lfs install
node --version
npm --version
python --version
```

PilotDeck requires Node.js **v22.13.0 or newer** because it uses the built-in `node:sqlite` runtime.

### Install WSL2 Ubuntu

For the recommended WSL2 path, install WSL2 and Ubuntu first from an elevated PowerShell window:

```powershell
wsl --install -d Ubuntu
```

Restart Windows if prompted, finish Ubuntu first-run user setup, then continue with Option A below inside the Ubuntu shell.

### Install Docker Desktop

For the Docker path, install Docker Desktop and enable the WSL2 backend:

```powershell
winget install Docker.DockerDesktop
```

Start Docker Desktop once after installation, wait until it says the engine is running, then verify:

```powershell
docker --version
docker compose version
```

## Option A: WSL2 Ubuntu (Recommended)

### 1. Install prerequisites

Open an Ubuntu shell in WSL2 and install the native build tools:

```bash
sudo apt update
sudo apt install -y git git-lfs build-essential python3 ripgrep curl ca-certificates
git lfs install
```

Install Node.js **v22.13.0 or newer**. For example, use your preferred Node version manager, then verify:

```bash
node --version
npm --version
```

### 2. Clone and install dependencies

If you do not need demo videos/GIFs, skip Git LFS media downloads:

```bash
export GIT_LFS_SKIP_SMUDGE=1
```

Then clone and install:

```bash
git clone https://github.com/OpenBMB/PilotDeck.git
cd PilotDeck

npm install
cd ui
npm install
cd ..
```

### 3. Prepare first-run configuration

PilotDeck reads `~/.pilotdeck/pilotdeck.yaml`. To start with the Web UI onboarding flow:

```bash
node scripts/bootstrap-pilotdeck-config.mjs
```

You can also edit the file manually:

```yaml
schemaVersion: 1
agent:
  model: openai/gpt-4.1
model:
  providers:
    openai:
      protocol: openai
      url: https://api.openai.com/v1
      apiKey: sk-your-api-key
      models:
        gpt-4.1: {}
```

### 4. Start PilotDeck

Development mode:

```bash
cd ui
npm run dev
```

Open the Vite UI at `http://localhost:5173`.

Production-style local mode:

```bash
cd ui
npm run start
```

Open `http://localhost:3001`.

## Option B: Docker Desktop

Docker avoids local Node/native build setup because the image installs the Linux build dependencies inside the container.

### 1. Install prerequisites

- Docker Desktop for Windows with WSL2 backend enabled.
- Git for Windows, if you want to clone from PowerShell.

### 2. Clone and start

From PowerShell:

```powershell
$env:GIT_LFS_SKIP_SMUDGE = '1'
git clone https://github.com/OpenBMB/PilotDeck.git
cd PilotDeck
docker compose up -d --build
```

Open `http://localhost:3001`.

To configure the provider through environment variables, edit `docker-compose.yml` or create an `.env` file:

```env
PILOTDECK_MODEL=openai/gpt-4.1
PILOTDECK_API_KEY=sk-your-api-key
PILOTDECK_API_URL=https://api.openai.com/v1
```

For more Docker options, see `README_DOCKER.md`.

## Option C: Native Windows

Native Windows is useful if you want to develop directly from PowerShell. It is more sensitive to native npm dependency compilation than WSL2.

### 1. Install prerequisites

Install the following tools and restart PowerShell after installation so `PATH` is refreshed:

- Node.js **v22.13.0 or newer**.
- Git for Windows and Git LFS.
- Python 3.
- Visual Studio Build Tools 2022 with the **Desktop development with C++** workload.
- ripgrep (`rg`) for built-in file/search tooling.

Bundled or embedded runtimes from other applications are not enough unless they also expose both `node` and `npm` on your terminal `PATH`.

Verify the tools:

```powershell
node --version
npm --version
git --version
git lfs version
python --version
rg --version
```

If native packages fail to compile, check that MSBuild and the Windows SDK were installed with Visual Studio Build Tools.

### 2. Clone and install dependencies

Use separate PowerShell lines instead of Bash-style chained commands:

```powershell
$env:GIT_LFS_SKIP_SMUDGE = '1'
git clone https://github.com/OpenBMB/PilotDeck.git
cd PilotDeck

npm install
cd ui
npm install
cd ..
```

### 3. Prepare first-run configuration

```powershell
node scripts/bootstrap-pilotdeck-config.mjs
```

The default config path is `%USERPROFILE%\.pilotdeck\pilotdeck.yaml`. You can edit it manually or finish provider/API key setup from the Web UI onboarding/settings panel.

### 4. Start PilotDeck

Development mode:

```powershell
cd ui
npm run dev
```

Open `http://localhost:5173`.

Production-style local mode:

```powershell
cd ui
npm run start
```

Open `http://localhost:3001`.

## Verified Portable Node Path

This path was verified on a clean Windows shell where `node`, `npm`, `docker`, and WSL2 were not available on `PATH`. It avoids system-wide Node installation by using the official Windows zip distribution for the current terminal session only.

Use this when you want to test PilotDeck before installing Node.js globally. For regular development, install Node.js normally and use Option C above.

### 1. Download official Node.js 22 zip

Run from PowerShell:

```powershell
$NodeVersion = '22.23.1'
$WorkDir = Join-Path $PWD '.pilotdeck-node'
$ZipPath = Join-Path $WorkDir "node-v$NodeVersion-win-x64.zip"
$NodeUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
Invoke-WebRequest -Uri $NodeUrl -OutFile $ZipPath
```

Optional but recommended: verify the checksum from the official SHASUMS file:

```powershell
Invoke-WebRequest -Uri "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt" -OutFile (Join-Path $WorkDir 'SHASUMS256.txt')
Get-Content (Join-Path $WorkDir 'SHASUMS256.txt') | Select-String "node-v$NodeVersion-win-x64.zip"
Get-FileHash -Algorithm SHA256 $ZipPath
```

### 2. Add portable Node to this PowerShell session

Use `tar` instead of `Expand-Archive` if PowerShell archive extraction fails on the Node zip:

```powershell
$ExtractDir = Join-Path $WorkDir 'node'
New-Item -ItemType Directory -Force -Path $ExtractDir | Out-Null
tar -xf $ZipPath -C $ExtractDir
$NodeDir = Join-Path $ExtractDir "node-v$NodeVersion-win-x64"
$env:PATH = "$NodeDir;$env:PATH"

node --version
npm.cmd --version
```

Use `npm.cmd` in PowerShell. Depending on the execution policy, calling `npm` may try to run `npm.ps1` and fail with `running scripts is disabled on this system`.

### 3. Clone, install, and build

```powershell
$env:GIT_LFS_SKIP_SMUDGE = '1'
git clone https://github.com/OpenBMB/PilotDeck.git
cd PilotDeck

npm.cmd install
cd ui
npm.cmd install
cd ..

node scripts/bootstrap-pilotdeck-config.mjs
npm.cmd run build
npm.cmd --prefix ui run build
```

The verified run completed root dependency install, UI dependency install, Gateway TypeScript build, and UI Vite production build on Windows with Node.js v22.23.1.

### 4. Start and verify production mode

```powershell
$env:SERVER_PORT = '3001'
$env:PILOTDECK_GATEWAY_PORT = '18789'
cd ui
npm.cmd run start:built
```

Open `http://localhost:3001`. A successful startup prints `PilotDeck Server - Ready`, the server URL, and the Gateway WebSocket URL.

In another PowerShell window, you can verify the HTTP endpoint:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3001
```

## Troubleshooting

### `node` or `npm` is not recognized

Install Node.js v22.13.0 or newer, restart the terminal, and check that the Node installation directory is on `PATH`.

### Native npm package build failures

Install Python 3 and Visual Studio Build Tools 2022 with the C++ workload. If the failure persists on native Windows, use WSL2 Ubuntu or Docker Desktop.

### `git lfs` is not recognized

Install Git LFS and run:

```powershell
git lfs install
```

### PowerShell blocks `npm.ps1`

Call `npm.cmd` instead of `npm`, or adjust your PowerShell execution policy.

### Port already in use

Development mode probes for free ports automatically. For production-style mode, set explicit ports before starting:

```powershell
$env:SERVER_PORT = '3002'
$env:PILOTDECK_GATEWAY_PORT = '18790'
cd ui
npm run start
```

### Corporate proxy

Set standard proxy variables before installing dependencies or starting services:

```powershell
$env:HTTPS_PROXY = 'http://127.0.0.1:7890'
$env:HTTP_PROXY = 'http://127.0.0.1:7890'
$env:PILOTDECK_PROXY = 'http://127.0.0.1:7890'
```

For Docker Desktop, use `host.docker.internal` when the proxy runs on the Windows host:

```env
PILOTDECK_PROXY=http://host.docker.internal:7890
```
