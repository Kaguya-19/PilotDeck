const {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
} = require("node:fs");
const { dirname, join, resolve } = require("node:path");

function getResourcesDir(context) {
  if (context.electronPlatformName === "darwin") {
    return join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      "Contents",
      "Resources",
    );
  }

  return join(context.appOutDir, "resources");
}

function materializeSymlinks(root) {
  let count = 0;

  function visit(path) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      try {
        const realPath = realpathSync(path);
        rmSync(path, { recursive: true, force: true });
        cpSync(realPath, path, {
          recursive: true,
          force: true,
          dereference: true,
        });
        count += 1;
      } catch {
        rmSync(path, { recursive: true, force: true });
        count += 1;
      }
      return;
    }

    if (!stat.isDirectory()) return;
    for (const entry of readdirSync(path)) {
      visit(join(path, entry));
    }
  }

  if (existsSync(root)) visit(root);
  return count;
}

module.exports = async function afterPack(context) {
  const desktopRoot = resolve(__dirname, "..");
  const resourcesDir = getResourcesDir(context);
  const source = resolve(desktopRoot, ".runtime", "app", "node_modules");
  const runtimeRoot = join(resourcesDir, "runtime");
  const nodeRoot = join(resourcesDir, "node");
  const target = join(runtimeRoot, "node_modules");

  if (!existsSync(source)) {
    throw new Error(`Desktop runtime dependencies missing: ${source}`);
  }

  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, {
    recursive: true,
    force: true,
    dereference: true,
  });
  rmSync(join(target, ".bin"), { recursive: true, force: true });
  const runtimeSymlinks = materializeSymlinks(runtimeRoot);
  const nodeSymlinks = materializeSymlinks(nodeRoot);
  console.log(
    `[desktop] afterPack materialized ${runtimeSymlinks} runtime symlinks and ${nodeSymlinks} node symlinks`,
  );

  for (const dependency of ["express", "edgeclaw-memory-core"]) {
    const dependencyPath = join(target, dependency);
    if (!existsSync(dependencyPath)) {
      throw new Error(`Desktop runtime dependency was not packaged: ${dependencyPath}`);
    }
  }
  for (const requiredFile of [
    join(target, "edgeclaw-memory-core", "lib", "index.js"),
    join(target, "edgeclaw-memory-core", "ui-source", "index.html"),
  ]) {
    if (!existsSync(requiredFile)) {
      throw new Error(`Desktop runtime dependency file was not packaged: ${requiredFile}`);
    }
  }
  if (existsSync(join(target, "tsx"))) {
    throw new Error(`Desktop runtime should not package tsx: ${join(target, "tsx")}`);
  }
};
