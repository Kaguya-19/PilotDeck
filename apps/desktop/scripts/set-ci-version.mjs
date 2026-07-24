#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const desktopRoot = path.resolve(__dirname, "..");
const packageJsonPath = path.join(desktopRoot, "package.json");

const version = process.env.PILOTDECK_DESKTOP_VERSION || buildDateVersion(new Date());
const buildTime = process.env.PILOTDECK_DESKTOP_BUILD_TIME || new Date().toISOString();
const commitSha = process.env.PILOTDECK_COMMIT_SHA || process.env.GITHUB_SHA || resolveGitCommit();

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
packageJson.version = version;
writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

exportGitHubEnv({
  PILOTDECK_DESKTOP_VERSION: version,
  PILOTDECK_COMMIT_SHA: commitSha,
  PILOTDECK_DESKTOP_BUILD_TIME: buildTime,
});

console.log(`PilotDeck desktop version set to ${version}`);
console.log(`PilotDeck desktop commit set to ${commitSha}`);
console.log(`PilotDeck desktop build time set to ${buildTime}`);

function buildDateVersion(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Shanghai",
      year: "2-digit",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `0.1.${parts.year}${parts.month}${parts.day}`;
}

function resolveGitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: path.resolve(desktopRoot, "..", ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function exportGitHubEnv(values) {
  if (!process.env.GITHUB_ENV) return;

  const lines = Object.entries(values)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${String(value).replace(/\r?\n/g, " ")}`);
  if (lines.length > 0) {
    appendFileSync(process.env.GITHUB_ENV, `${lines.join("\n")}\n`);
  }
}
