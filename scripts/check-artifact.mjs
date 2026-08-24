import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const required = [
  packageJson.bin?.pilotdeck,
  "dist/src/cli/index.js",
  "dist/src/gateway/index.js",
  "dist/src/model/index.js",
].filter(Boolean);
const missing = required.filter((relative) => !fs.existsSync(path.join(root, relative)));
if (missing.length > 0) {
  console.error(`构建产物缺失：${missing.join(", ")}`);
  process.exit(1);
}

for (const relative of required) {
  const absolute = path.join(root, relative);
  if (relative.endsWith(".js")) {
    const source = fs.readFileSync(absolute, "utf8");
    if (!source.trim()) {
      console.error(`构建产物为空：${relative}`);
      process.exit(1);
    }
  }
}

await import(pathToFileURL(path.join(root, "dist/src/cli/index.js")));
await import(pathToFileURL(path.join(root, "dist/src/gateway/index.js")));
console.log(`构建产物检查通过：${required.join(", ")}`);
