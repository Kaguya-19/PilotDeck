import path from "node:path";

export type LintDiagnostic = {
  line: number;
  column: number;
  severity: "error" | "warning";
  message: string;
};

export type LintResult = {
  ok: boolean;
  diagnostics: LintDiagnostic[];
};

const LINTABLE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
]);

export function isLintableFile(filePath: string): boolean {
  return LINTABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export async function lintAfterWrite(filePath: string, content: string): Promise<LintResult> {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".json") {
    return lintJson(content);
  }

  if (LINTABLE_EXTENSIONS.has(ext)) {
    return lintTypeScript(filePath, content, ext);
  }

  return { ok: true, diagnostics: [] };
}

export function formatLintDiagnostics(diagnostics: LintDiagnostic[]): string {
  if (diagnostics.length === 0) return "";
  const lines = diagnostics.map((d) => `  L${d.line}:${d.column} ${d.severity}: ${d.message}`);
  return `\n\nSyntax issues detected:\n${lines.join("\n")}`;
}

function lintJson(content: string): LintResult {
  try {
    JSON.parse(content);
    return { ok: true, diagnostics: [] };
  } catch (error) {
    const message = error instanceof SyntaxError ? error.message : String(error);
    const position = extractJsonErrorPosition(message);
    const location = position !== undefined ? locationForPosition(content, position) : { line: 1, column: 1 };
    return {
      ok: false,
      diagnostics: [{ ...location, severity: "error", message }],
    };
  }
}

async function lintTypeScript(filePath: string, content: string, ext: string): Promise<LintResult> {
  let ts: typeof import("typescript");
  try {
    ts = await import("typescript");
  } catch {
    return { ok: true, diagnostics: [] };
  }

  const scriptKindMap: Record<string, import("typescript").ScriptKind> = {
    ".ts": ts.ScriptKind.TS,
    ".tsx": ts.ScriptKind.TSX,
    ".mts": ts.ScriptKind.TS,
    ".cts": ts.ScriptKind.TS,
    ".js": ts.ScriptKind.JS,
    ".jsx": ts.ScriptKind.JSX,
    ".mjs": ts.ScriptKind.JS,
    ".cjs": ts.ScriptKind.JS,
  };

  const sourceFile = ts.createSourceFile(
    path.basename(filePath),
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindMap[ext] ?? ts.ScriptKind.TS,
  );
  const parseDiagnostics = (
    sourceFile as unknown as {
      parseDiagnostics?: Array<{
        start?: number;
        messageText: import("typescript").DiagnosticMessageChain | string;
      }>;
    }
  ).parseDiagnostics ?? [];

  if (parseDiagnostics.length === 0) {
    return { ok: true, diagnostics: [] };
  }

  return {
    ok: false,
    diagnostics: parseDiagnostics.map((diag) => {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(diag.start ?? 0);
      return {
        line: line + 1,
        column: character + 1,
        severity: "error",
        message: ts.flattenDiagnosticMessageText(diag.messageText, "\n"),
      };
    }),
  };
}

function extractJsonErrorPosition(message: string): number | undefined {
  const match = message.match(/position (\d+)/i);
  if (!match) return undefined;
  const position = Number.parseInt(match[1], 10);
  return Number.isFinite(position) ? position : undefined;
}

function locationForPosition(content: string, position: number): { line: number; column: number } {
  const before = content.slice(0, Math.max(0, position));
  const line = (before.match(/\n/g) ?? []).length + 1;
  const lastNewline = before.lastIndexOf("\n");
  return { line, column: position - lastNewline };
}
