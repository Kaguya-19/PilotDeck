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
  ".ts", ".tsx", ".mts", ".cts",
  ".js", ".jsx", ".mjs", ".cjs",
  ".json",
]);

export function isLintableFile(filePath: string): boolean {
  return LINTABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Fast in-process syntax check for TypeScript/JavaScript/JSON files.
 * Uses TypeScript's parser when available (zero network, microsecond-scale).
 * Returns only syntax-level diagnostics introduced by the current content.
 */
export async function lintAfterWrite(
  filePath: string,
  content: string,
): Promise<LintResult> {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".json") {
    return lintJson(content);
  }

  if (LINTABLE_EXTENSIONS.has(ext)) {
    return lintTypeScript(filePath, content, ext);
  }

  return { ok: true, diagnostics: [] };
}

function lintJson(content: string): LintResult {
  try {
    JSON.parse(content);
    return { ok: true, diagnostics: [] };
  } catch (error) {
    const message = error instanceof SyntaxError ? error.message : String(error);
    const lineMatch = message.match(/position (\d+)/i);
    let line = 1;
    let column = 1;
    if (lineMatch) {
      const pos = Number.parseInt(lineMatch[1], 10);
      const before = content.slice(0, pos);
      line = (before.match(/\n/g) || []).length + 1;
      const lastNewline = before.lastIndexOf("\n");
      column = pos - lastNewline;
    }
    return {
      ok: false,
      diagnostics: [{ line, column, severity: "error", message }],
    };
  }
}

async function lintTypeScript(
  filePath: string,
  content: string,
  ext: string,
): Promise<LintResult> {
  let ts: typeof import("typescript");
  try {
    ts = await import("typescript");
  } catch {
    return { ok: true, diagnostics: [] };
  }

  const scriptKindMap: Record<string, number> = {
    ".ts": ts.ScriptKind.TS,
    ".tsx": ts.ScriptKind.TSX,
    ".mts": ts.ScriptKind.TS,
    ".cts": ts.ScriptKind.TS,
    ".js": ts.ScriptKind.JS,
    ".jsx": ts.ScriptKind.JSX,
    ".mjs": ts.ScriptKind.JS,
    ".cjs": ts.ScriptKind.JS,
  };

  const scriptKind = scriptKindMap[ext] ?? ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    path.basename(filePath),
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );

  const parseDiagnostics = (sourceFile as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics;
  if (!parseDiagnostics || parseDiagnostics.length === 0) {
    return { ok: true, diagnostics: [] };
  }

  const diagnostics: LintDiagnostic[] = [];
  for (const diag of parseDiagnostics as Array<{ start?: number; messageText: unknown }>) {
    const pos = diag.start ?? 0;
    const before = content.slice(0, pos);
    const line = (before.match(/\n/g) || []).length + 1;
    const lastNewline = before.lastIndexOf("\n");
    const column = pos - lastNewline;
    const message = typeof diag.messageText === "string"
      ? diag.messageText
      : String(diag.messageText);
    diagnostics.push({ line, column, severity: "error", message });
  }

  return { ok: diagnostics.length === 0, diagnostics };
}

export function formatLintDiagnostics(diagnostics: LintDiagnostic[]): string {
  if (diagnostics.length === 0) return "";
  const lines = diagnostics.map(
    (d) => `  L${d.line}:${d.column} ${d.severity}: ${d.message}`,
  );
  return `\n\nSyntax issues detected:\n${lines.join("\n")}`;
}
