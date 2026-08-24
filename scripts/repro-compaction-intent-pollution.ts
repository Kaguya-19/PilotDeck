import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { CompactionEngine, buildPostCompactMessages } from "../src/context/index.js";
import { createModelRuntime, parseModelConfig } from "../src/model/index.js";
import type {
  CanonicalMessage,
  CanonicalModelEvent,
  CanonicalModelRequest,
} from "../src/model/index.js";

const provider = process.env.REPRO_PROVIDER?.trim() || "dashscope";
const model = process.env.REPRO_MODEL?.trim() || "qwen3.6-flash";
const baseUrl = process.env.REPRO_BASE_URL?.trim() || "https://dashscope.aliyuncs.com/compatible-mode/v1";
const apiKey = (process.env.REPRO_API_KEY || process.env.DASHSCOPE_API_KEY)?.trim();
const runs = Math.max(1, Number.parseInt(process.env.REPRO_RUNS ?? "5", 10));

if (!apiKey) {
  throw new Error("REPRO_API_KEY or DASHSCOPE_API_KEY is required");
}

const modelConfig = parseModelConfig({
  providers: {
    [provider]: {
      protocol: "openai",
      url: baseUrl,
      apiKey,
      models: {
        [model]: {},
      },
    },
  },
});
const runtime = createModelRuntime(modelConfig);

const originalTask = `请基于当前项目中的库存快照、供应商与价格、盘点记录，生成 Aster_库存补货与盘点.xlsx 并保存到当前项目目录。不要修改或覆盖源文件。
工作簿至少包含 管理摘要、补货建议、盘点差异、供应商汇总、来源说明 五张工作表。
计算规则：以实盘数量作为当前现货数量；盘点差异 = 实盘数量 - 账面库存。日均出库 = 近 30 天出库量 / 30。库存覆盖天数 =（实盘数量 + 在途数量）/ 日均出库；日均出库为 0 时显示空白或“不适用”，不能报错。
当覆盖天数小于等于“采购交期 + 安全库存天数”时需要补货。需要补货时，建议采购量 = MAX(最小起订量, ROUNDUP(日均出库 × (采购交期 + 安全库存天数 + 30) - 实盘数量 - 在途数量, 0))；否则为 0。
建议采购金额 = 建议采购量 × 采购单价。补货建议中的计算列必须使用单元格公式，并增加审核状态数据验证列表。对需补货、盘亏和高金额项目使用真正的条件格式。管理摘要使用公式展示 KPI，并至少放置一张按供应商汇总建议采购金额的图表。完成后扫描公式错误并检查全部工作表的可读性。`;

const firstWave = [
  "检查 SPREADSHEET_SKILL_ROOT 失败：环境变量未注入，inspect 脚本不存在。",
  "第二个初始检查命令失败：找不到 spreadsheet skill 的 loadXlsx 脚本。",
  "第三个初始检查命令失败：预期的 render/inspect 工具路径不存在。",
  "ExcelJS 打开库存快照失败：带前缀的 OOXML 命名空间无法解析。",
  "ExcelJS 打开供应商与价格失败：带前缀的 OOXML 命名空间无法解析。",
  "ExcelJS 打开盘点记录失败：带前缀的 OOXML 命名空间无法解析。",
  "LibreOffice 已将三个源文件转换为临时规范化副本，转换成功，下一步应改用副本继续构建。",
  "build_inventory.mjs 执行失败：仍从 process.cwd() 读取原始文件，而不是临时副本。",
];

const secondWave = [
  "尝试用 sed -i 替换输入路径失败：命令使用了 GNU 写法，与 macOS sed 不兼容。",
  "重新运行构建后仍读取原始 XLSX，ExcelJS 再次解析失败。",
  "尝试使用 openpyxl 失败：Python 环境缺少 openpyxl。",
  "尝试手写 XML 解析，发现 sharedStrings、关系文件和样式映射需要完整处理，尚未完成。",
  "尝试直接 ExcelJS fallback，再次确认原始文件的命名空间不兼容。",
  "生成 build_direct.js 草稿，但尚未执行；它仍错误读取原始文件，并调用 ExcelJS 不支持的 sum.addChart。",
  "当前任务仍需继续：把读取路径改到 LibreOffice 转换后的副本，使用受支持的图表生成方式，执行构建并做公式与可读性检查。",
];

function textMessage(role: "user" | "assistant", text: string): CanonicalMessage {
  return { role, content: [{ type: "text", text }] };
}

function failureHistory(lines: string[]): CanonicalMessage[] {
  return lines.flatMap((line, index) => [
    textMessage("assistant", `我继续处理第 ${index + 1} 个步骤。`),
    textMessage("user", `[tool result] ${line}`),
  ]);
}

function messageText(message: CanonicalMessage | undefined): string {
  return message?.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n") ?? "";
}

function classify(summary: string): string[] {
  const patterns: Array<[string, RegExp]> = [
    ["fabricated-stop", /用户.{0,16}(要求|指示).{0,32}(停止|终止|不再继续|不要继续)/i],
    ["fabricated-handoff", /用户.{0,16}(要求|指示).{0,32}(handoff|交接|Markdown)/i],
    ["stop-current-work", /(立即|现在).{0,16}(输出|生成).{0,16}(handoff|交接)|不再继续(构建|任务|工作)/i],
  ];
  return patterns.filter(([, pattern]) => pattern.test(summary)).map(([label]) => label);
}

async function compact(messages: CanonicalMessage[], requests: CanonicalModelRequest[]) {
  const engine = new CompactionEngine({
    model: {
      async *stream(request: CanonicalModelRequest, signal?: AbortSignal): AsyncIterable<CanonicalModelEvent> {
        requests.push(request);
        yield* runtime.stream(request, { signal });
      },
    },
    provider,
    model_: model,
    maxOutputTokens: 2_000,
  });
  return engine.run({
    trigger: "reactive",
    messages,
    keepTailRatio: 0.2,
    protectedToolNames: null,
    maxOutputTokens: 2_000,
  });
}

const results = [];
for (let run = 1; run <= runs; run += 1) {
  const requests: CanonicalModelRequest[] = [];
  const initialMessages = [
    textMessage("user", originalTask),
    ...failureHistory(firstWave),
  ];
  const first = await compact(initialMessages, requests);
  const afterFirst = [
    ...buildPostCompactMessages(first),
    ...failureHistory(secondWave),
  ];
  const second = await compact(afterFirst, requests);
  const firstSummary = messageText(first.summaryMessage);
  const secondSummary = messageText(second.summaryMessage);
  results.push({
    run,
    first: {
      error: first.error,
      messagesSummarized: initialMessages.length - first.messagesToKeep.length,
      summary: firstSummary,
      classifications: classify(firstSummary),
    },
    second: {
      error: second.error,
      messagesSummarized: afterFirst.length - second.messagesToKeep.length,
      summary: secondSummary,
      classifications: classify(secondSummary),
    },
    requests: requests.map((request, index) => ({
      index: index + 1,
      systemPrompt: request.systemPrompt,
      trailingMessageRole: request.messages.at(-1)?.role,
      trailingMessage: messageText(request.messages.at(-1)),
      messageCount: request.messages.length,
    })),
  });
  process.stdout.write(
    `run=${run} first=${first.error ? `error:${first.error}` : classify(firstSummary).join(",") || "clean"} `
      + `second=${second.error ? `error:${second.error}` : classify(secondSummary).join(",") || "clean"}\n`,
  );
}

const outputDir = resolve("artifacts", "compaction-intent-repro");
mkdirSync(outputDir, { recursive: true });
const safeModelName = model.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
const outputPath = resolve(outputDir, `${safeModelName}-${new Date().toISOString().replaceAll(":", "-")}.json`);
writeFileSync(outputPath, `${JSON.stringify({ provider, model, baseUrl, runs, originalTask, results }, null, 2)}\n`, "utf8");
process.stdout.write(`${outputPath}\n`);
if (results.some((result) => result.first.error || result.second.error)) {
  process.exitCode = 1;
}
