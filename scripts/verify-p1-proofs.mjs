import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const cases = [
  {
    id: "duplicate-terminal",
    file: "src/agent/turn/TurnRunner.ts",
    test: "tests/agent/turn-runner-contract.spec.ts",
    from: "if (turnCompletedEvent) {\n          yield turnCompletedEvent;\n        }",
    to: "if (turnCompletedEvent) {\n          yield turnCompletedEvent;\n          yield turnCompletedEvent;\n        }",
  },
  {
    id: "manual-title-priority",
    file: "src/agent/turn/TurnRunner.ts",
    test: "tests/session/turn-runner-title-race.spec.ts",
    from: "if (latest.title || latest.aiTitle) {",
    to: "if (false) {",
  },
  {
    id: "gateway-error-code",
    file: "src/gateway/server/GatewayWsConnection.ts",
    test: "tests/gateway/websocket-contract.spec.ts",
    from: 'code: "gateway_request_failed",',
    to: 'code: "mutated_gateway_error",',
  },
  {
    id: "tool-result-identity",
    file: "src/gateway/client/InProcessGateway.ts",
    test: "tests/gateway/map-agent-event-runid.spec.ts",
    from: "type: \"tool_call_finished\",\n          toolCallId: event.result.toolCallId,",
    to: "type: \"tool_call_finished\",\n          toolCallId: \"mutated-tool-call\",",
  },
];

function printList() {
  for (const item of cases) console.log(`${item.id}\t${item.test}`);
}

function runTest(cwd, testFile) {
  const tsx = path.join(root, "node_modules", ".bin", "tsx");
  const result = spawnSync(tsx, ["--test", testFile], {
    cwd,
    stdio: "pipe",
    encoding: "utf8",
    env: { ...process.env, PILOT_HOME: path.join(cwd, ".pilot-home") },
  });
  return result;
}

async function makeCopy() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pilotdeck-p1-proof-"));
  for (const name of ["src", "tests", "package.json", "tsconfig.json"]) {
    await fs.cp(path.join(root, name), path.join(temp, name), { recursive: true });
  }
  await fs.symlink(path.join(root, "node_modules"), path.join(temp, "node_modules"), "junction");
  return temp;
}

async function applyMutation(temp, item) {
  const file = path.join(temp, item.file);
  const content = await fs.readFile(file, "utf8");
  const matches = content.split(item.from).length - 1;
  if (matches !== 1) throw new Error(`${item.id}: expected one mutation location, found ${matches}`);
  await fs.writeFile(file, content.replace(item.from, item.to));
}

async function verify(item) {
  const temp = await makeCopy();
  try {
    const baseline = runTest(temp, item.test);
    if (baseline.status !== 0) {
      throw new Error(`${item.id}: baseline failed before mutation\n${baseline.stdout}${baseline.stderr}`);
    }
    await applyMutation(temp, item);
    const mutated = runTest(temp, item.test);
    if (mutated.status === 0) {
      throw new Error(`${item.id}: mutation unexpectedly passed\n${mutated.stdout}${mutated.stderr}`);
    }
    console.log(`MUTATION_FAIL ${item.id}`);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

const listOnly = process.argv.includes("--list");
const selected = process.argv.includes("--case")
  ? cases.filter((item) => item.id === process.argv[process.argv.indexOf("--case") + 1])
  : cases;
if (listOnly) {
  printList();
} else if (selected.length === 0) {
  console.error("unknown P1 proof case");
  process.exitCode = 2;
} else {
  for (const item of selected) await verify(item);
}
