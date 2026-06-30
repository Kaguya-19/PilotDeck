#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  resolvePlaywrightBrowserSet,
  resolvePlaywrightMirrorMode,
} from "./download-playwright-browsers.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const runtimeRoot = resolve(desktopRoot, ".runtime", "app");
const DESKTOP_BUILD = "260623";
const DESKTOP_PLAYWRIGHT_BROWSER = "chrome-for-testing";

const uiServerDependencies = [
  "@octokit/rest",
  "bcrypt",
  "better-sqlite3",
  "chokidar",
  "clawhub",
  "cors",
  "express",
  "gray-matter",
  "jsonwebtoken",
  "jszip",
  "mime-types",
  "multer",
  "node-fetch",
  "node-pty",
  "shell-quote",
  "undici",
  "web-push",
  "ws",
  "yaml",
];

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function run(command, args, cwd, env = process.env) {
  console.log(`[desktop] ${command} ${args.join(" ")} (${cwd})`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32" && command.endsWith(".cmd"),
    env,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}

const npmExecPath = process.env.npm_execpath ?? "";
const isPnpmExecPath = npmExecPath.replaceAll("\\", "/").includes("/pnpm/");
const packageManager = isPnpmExecPath
  ? { command: process.execPath, args: [process.env.npm_execpath] }
  : { command: process.platform === "win32" ? "pnpm.cmd" : "pnpm", args: [] };

function runPnpm(args, cwd = repoRoot, env = process.env) {
  run(packageManager.command, [...packageManager.args, ...args], cwd, env);
}

function withBundledPlaywrightEnv(env = process.env) {
  return {
    ...env,
    PLAYWRIGHT_BROWSERS_PATH: "0",
  };
}

function copyFiltered(from, to, filter) {
  cpSync(from, to, {
    recursive: true,
    force: true,
    filter: (source) => {
      const rel = relative(from, source).replaceAll("\\", "/");
      return filter(rel, source);
    },
  });
}

function skipBuildArtifact(rel) {
  return !(
    rel.endsWith(".map") ||
    rel.endsWith(".d.ts") ||
    rel.endsWith(".tsbuildinfo")
  );
}

function addDependency(target, sources, name) {
  for (const source of sources) {
    const version = source.dependencies?.[name] ?? source.devDependencies?.[name];
    if (version) {
      target[name] = version;
      return;
    }
  }
  throw new Error(`Missing runtime dependency version for ${name}`);
}

function createRuntimePackageJson(rootPackage, uiPackage) {
  const dependencies = {};
  for (const [name, version] of Object.entries(rootPackage.dependencies ?? {})) {
    if (!name.startsWith("@types/")) {
      dependencies[name] = version;
    }
  }
  for (const name of uiServerDependencies) {
    addDependency(dependencies, [uiPackage, rootPackage], name);
  }

  return {
    name: "pilotdeck-desktop-runtime",
    version: rootPackage.version,
    private: true,
    type: "module",
    packageManager: rootPackage.packageManager,
    dependencies,
  };
}

function prepareRuntimeTree() {
  const rootPackage = readJson(resolve(repoRoot, "package.json"));
  const uiPackage = readJson(resolve(repoRoot, "ui", "package.json"));
  rmSync(runtimeRoot, { recursive: true, force: true });
  mkdirSync(runtimeRoot, { recursive: true });

  writeFileSync(
    resolve(runtimeRoot, "package.json"),
    `${JSON.stringify(createRuntimePackageJson(rootPackage, uiPackage), null, 2)}\n`,
  );
  copyFiltered(resolve(repoRoot, "dist"), resolve(runtimeRoot, "dist"), skipBuildArtifact);
  copyFiltered(
    resolve(repoRoot, "src", "context", "memory", "edgeclaw-memory-core"),
    resolve(runtimeRoot, "src", "context", "memory", "edgeclaw-memory-core"),
    skipBuildArtifact,
  );
  copyFiltered(resolve(repoRoot, "ui", "server"), resolve(runtimeRoot, "ui", "server"), skipBuildArtifact);
  copyFiltered(resolve(repoRoot, "ui", "shared"), resolve(runtimeRoot, "ui", "shared"), skipBuildArtifact);
  copyFiltered(resolve(repoRoot, "ui", "public"), resolve(runtimeRoot, "ui", "public"), () => true);
  copyFiltered(resolve(repoRoot, "ui", "dist"), resolve(runtimeRoot, "ui", "dist"), () => true);
  rewriteUiServerSourceImports(resolve(runtimeRoot, "ui", "server"));
  writeFileSync(
    resolve(runtimeRoot, "ui", "package.json"),
    `${JSON.stringify({
      name: "pilotdeck-ui-runtime",
      version: uiPackage.version,
      private: true,
      type: "module",
    }, null, 2)}\n`,
  );

  runPnpm([
    "install",
    "--prod",
    "--ignore-workspace",
    "--config.node-linker=hoisted",
    "--no-frozen-lockfile",
    "--prefer-offline",
  ], runtimeRoot, withBundledPlaywrightEnv());

  installRuntimePlaywrightBrowser();

  removeIfExists(resolve(runtimeRoot, "src"));
}

function installRuntimePlaywrightBrowser() {
  const cli = resolve(runtimeRoot, "node_modules", "@playwright", "mcp", "cli.js");
  if (!existsSync(cli)) {
    throw new Error(`Desktop runtime Playwright MCP CLI missing: ${cli}`);
  }
  const browserSet = resolvePlaywrightBrowserSet(process.env);
  const mirrorMode = resolvePlaywrightMirrorMode(process.env);
  if (mirrorMode === "npmmirror") {
    run(
      process.execPath,
      [resolve(desktopRoot, "scripts", "download-playwright-browsers.mjs"), runtimeRoot],
      runtimeRoot,
      withBundledPlaywrightEnv(),
    );
    return;
  }
  if (mirrorMode !== "official") {
    throw new Error(`Unsupported desktop Playwright browser mirror: ${mirrorMode}`);
  }
  const args = [cli, "install-browser", DESKTOP_PLAYWRIGHT_BROWSER];
  if (browserSet === "browser-only") {
    args.push("--no-shell");
  }
  run(
    process.execPath,
    args,
    runtimeRoot,
    withBundledPlaywrightEnv(),
  );
  pruneRuntimePlaywrightBrowsers(browserSet);
}

function pruneRuntimePlaywrightBrowsers(browserSet) {
  if (browserSet === "full") return;
  if (browserSet !== "browser-only") {
    throw new Error(`Unsupported desktop Playwright browser set: ${browserSet}`);
  }

  const browsersRoot = resolve(runtimeRoot, "node_modules", "playwright-core", ".local-browsers");
  let removed = 0;
  for (const entry of cpSafeReadDir(browsersRoot)) {
    if (entry === ".links" || entry.startsWith("chromium-")) continue;
    rmSync(resolve(browsersRoot, entry), { recursive: true, force: true });
    removed += 1;
  }
  if (removed) {
    console.log(`[desktop] pruned ${removed} unused Playwright browser entries`);
  }
}

function pruneRuntimeTree() {
  const nodeModules = resolve(runtimeRoot, "node_modules");
  const playwrightBrowsersRoot = resolve(nodeModules, "playwright-core", ".local-browsers");
  const pruneExtensions = new Set([".map", ".d.ts", ".pdb", ".tsbuildinfo"]);
  const pruneDirs = new Set([
    ".cache",
    ".github",
    ".vite",
    "coverage",
    "docs",
    "example",
    "examples",
    "test",
    "tests",
  ]);

  function visit(path) {
    if (path === playwrightBrowsersRoot) return;

    const stat = statSync(path);
    if (stat.isDirectory()) {
      const name = path.split(/[\\/]/).pop();
      if (pruneDirs.has(name)) {
        rmSync(path, { recursive: true, force: true });
        return;
      }
      for (const entry of cpSafeReadDir(path)) {
        visit(resolve(path, entry));
      }
      return;
    }

    for (const ext of pruneExtensions) {
      if (path.endsWith(ext)) {
        rmSync(path, { force: true });
        return;
      }
    }
  }

  visit(nodeModules);
  prunePackageSpecificFiles();
}

function cpSafeReadDir(path) {
  try {
    return statSync(path).isDirectory() ? readdirSync(path) : [];
  } catch {
    return [];
  }
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function directorySize(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return 0;
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of cpSafeReadDir(path)) {
    total += directorySize(resolve(path, entry));
  }
  return total;
}

function removeIfExists(path) {
  rmSync(path, { recursive: true, force: true });
}

function keepOnlySubdir(parent, keepName) {
  if (!existsSync(resolve(parent, keepName))) return;
  for (const entry of cpSafeReadDir(parent)) {
    if (entry !== keepName) removeIfExists(resolve(parent, entry));
  }
}

function prunePackageSpecificFiles() {
  const nodeModules = resolve(runtimeRoot, "node_modules");
  const nodePtyRoot = resolve(nodeModules, "node-pty");
  const nodePtyPrebuild = `${process.platform}-${process.arch}`;

  removeIfExists(resolve(nodePtyRoot, "deps"));
  removeIfExists(resolve(nodePtyRoot, "node_modules"));
  removeIfExists(resolve(nodePtyRoot, "scripts"));
  removeIfExists(resolve(nodePtyRoot, "src"));
  removeIfExists(resolve(nodePtyRoot, "third_party"));
  removeIfExists(resolve(nodePtyRoot, "typings"));
  keepOnlySubdir(resolve(nodePtyRoot, "prebuilds"), nodePtyPrebuild);

  removeIfExists(resolve(nodeModules, "better-sqlite3", "deps"));
  removeIfExists(resolve(nodeModules, "better-sqlite3", "src"));

  removeIfExists(resolve(nodeModules, "edgeclaw-memory-core", "src"));
  removeIfExists(resolve(nodeModules, "edgeclaw-memory-core", "tsconfig.json"));
  removeIfExists(resolve(nodeModules, "edgeclaw-memory-core", "tsconfig.base.json"));
}

function rewriteUiServerSourceImports(serverRoot) {
  const extensions = new Set([".js"]);

  function visit(path) {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const entry of cpSafeReadDir(path)) {
        visit(resolve(path, entry));
      }
      return;
    }
    if (!extensions.has(path.slice(path.lastIndexOf(".")))) return;

    const original = readFileSync(path, "utf8");
    const rewritten = original
      .replaceAll("../../src/", "../../dist/src/")
      .replaceAll("../../../src/", "../../../dist/src/");
    if (rewritten !== original) {
      writeFileSync(path, rewritten, "utf8");
    }
  }

  visit(serverRoot);
}

run(process.execPath, [resolve(desktopRoot, "scripts", "download-node.mjs")], desktopRoot);
if (process.platform === "win32") {
  run(process.execPath, [resolve(desktopRoot, "scripts", "download-git-bash.mjs")], desktopRoot);
}

if (process.env.PILOTDECK_DESKTOP_SKIP_RUNTIME_BUILD !== "1") {
  runPnpm(["--dir", repoRoot, "run", "build"]);
  runPnpm(
    ["--dir", repoRoot, "--filter", "pilotdeck-ui", "run", "build"],
    repoRoot,
    { ...process.env, VITE_PILOTDECK_DESKTOP_BUILD: DESKTOP_BUILD },
  );
}

const sourceRequired = [
  resolve(repoRoot, "dist", "src", "cli", "pilotdeck.js"),
  resolve(repoRoot, "ui", "dist", "index.html"),
  resolve(repoRoot, "ui", "server", "index.js"),
  resolve(repoRoot, "src", "context", "memory", "edgeclaw-memory-core", "lib", "index.js"),
  resolve(repoRoot, "src", "context", "memory", "edgeclaw-memory-core", "ui-source", "index.html"),
];

for (const file of sourceRequired) {
  if (!existsSync(file)) {
    throw new Error(`Desktop runtime source prerequisite missing: ${file}`);
  }
}

prepareRuntimeTree();
pruneRuntimeTree();

const runtimeRequired = [
  resolve(runtimeRoot, "dist", "src", "cli", "pilotdeck.js"),
  resolve(runtimeRoot, "ui", "dist", "index.html"),
  resolve(runtimeRoot, "ui", "server", "index.js"),
  resolve(runtimeRoot, "node_modules", "express"),
  resolve(runtimeRoot, "node_modules", "@playwright", "mcp", "cli.js"),
  resolve(runtimeRoot, "node_modules", "playwright-core", ".local-browsers"),
  resolve(runtimeRoot, "node_modules", "edgeclaw-memory-core", "lib", "index.js"),
  resolve(runtimeRoot, "node_modules", "edgeclaw-memory-core", "ui-source", "index.html"),
];

for (const file of runtimeRequired) {
  if (!existsSync(file)) {
    throw new Error(`Desktop runtime staged prerequisite missing: ${file}`);
  }
}

if (existsSync(resolve(runtimeRoot, "src"))) {
  throw new Error(`Desktop runtime should not include source tree: ${resolve(runtimeRoot, "src")}`);
}

if (existsSync(resolve(runtimeRoot, "node_modules", "tsx"))) {
  throw new Error(`Desktop runtime should not include tsx: ${resolve(runtimeRoot, "node_modules", "tsx")}`);
}

console.log(`[desktop] staged runtime ready: ${runtimeRoot}`);
console.log(`[desktop] staged runtime size: ${formatBytes(directorySize(runtimeRoot))}`);
