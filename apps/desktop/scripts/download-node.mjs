#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, rmSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { downloadToFile, resolveDownloadSource } from "./download-sources.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..");
const version = process.env.PILOTDECK_DESKTOP_NODE_VERSION || "22.23.1";
const targetDir = resolve(desktopRoot, "resources", "node");
const tmpDir = resolve(desktopRoot, "resources", ".node-download");

const platformMap = {
  darwin: "darwin",
  linux: "linux",
  win32: "win",
};
const archMap = {
  arm64: "arm64",
  x64: "x64",
};

const nodePlatform = platformMap[process.platform];
const nodeArch = archMap[process.arch];
if (!nodePlatform || !nodeArch) {
  throw new Error(`Unsupported platform for bundled Node: ${process.platform}/${process.arch}`);
}

const nodeBinary = process.platform === "win32"
  ? join(targetDir, "node.exe")
  : join(targetDir, "bin", "node");

function pruneNodeDistribution() {
  const removable = process.platform === "win32"
    ? [
        "CHANGELOG.md",
        "README.md",
        "corepack",
        "corepack.cmd",
        "install_tools.bat",
        "node_etw_provider.man",
        "node_modules",
        "npm",
        "npm.cmd",
        "npx",
        "npx.cmd",
      ]
    : [
        "CHANGELOG.md",
        "README.md",
        "bin/corepack",
        "bin/npm",
        "bin/npx",
        "include",
        "lib",
        "share",
      ];
  for (const entry of removable) {
    rmSync(join(targetDir, entry), { recursive: true, force: true });
  }
}

if (existsSync(nodeBinary)) {
  const result = spawnSync(nodeBinary, ["--version"], { encoding: "utf8" });
  if (result.stdout.trim() === `v${version}`) {
    pruneNodeDistribution();
    console.log(`[desktop] bundled Node already present: ${result.stdout.trim()}`);
    process.exit(0);
  }
}

const name = `node-v${version}-${nodePlatform}-${nodeArch}`;
const ext = process.platform === "win32" ? "zip" : "tar.gz";
const archiveName = `${name}.${ext}`;
const source = resolveDownloadSource({
  archiveEnv: "PILOTDECK_DESKTOP_NODE_ARCHIVE",
  urlEnv: "PILOTDECK_DESKTOP_NODE_URL",
  baseEnv: "PILOTDECK_DESKTOP_NODE_BASE_URL",
  chinaBaseUrl: "https://mirrors.aliyun.com/nodejs-release",
  officialBaseUrl: "https://nodejs.org/dist",
  relativePath: `v${version}/${archiveName}`,
});

rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });

let archivePath;
if (source.type === "archive") {
  archivePath = source.path;
  if (!existsSync(archivePath)) {
    throw new Error(`Bundled Node archive not found: ${archivePath}`);
  }
  console.log(`[desktop] using bundled Node archive from ${source.source}: ${archivePath}`);
} else {
  archivePath = join(tmpDir, archiveName);
  await downloadToFile(source.url, archivePath);
}

rmSync(targetDir, { recursive: true, force: true });

console.log(`[desktop] extracting ${archivePath}`);
const extract = spawnSync("tar", ["-xf", archivePath, "-C", tmpDir], { stdio: "inherit" });
if (extract.status !== 0) {
  throw new Error("Failed to extract Node archive with tar");
}

renameSync(join(tmpDir, name), targetDir);
rmSync(tmpDir, { recursive: true, force: true });
if (process.platform !== "win32") chmodSync(nodeBinary, 0o755);
pruneNodeDistribution();
console.log(`[desktop] bundled Node ready: ${nodeBinary}`);
