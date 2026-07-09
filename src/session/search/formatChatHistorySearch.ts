import type { ChatHistorySearchMatch, SearchChatHistoryResult } from "./searchChatHistory.js";

export type FormatChatHistorySearchOptions = {
  locale?: "zh" | "en";
  includeProject?: boolean;
};

export function formatChatHistorySearchResults(
  result: SearchChatHistoryResult,
  options: FormatChatHistorySearchOptions = {},
): string {
  const locale = options.locale ?? "zh";
  const includeProject = options.includeProject ?? false;

  if (!result.query.trim()) {
    return locale === "zh"
      ? "用法：/search <关键词> [--all] [--limit N] [--role user|assistant]\n示例：/search docker 部署"
      : "Usage: /search <keyword> [--all] [--limit N] [--role user|assistant]\nExample: /search docker deploy";
  }

  if (result.matches.length === 0) {
    const scope = locale === "zh"
      ? `已扫描 ${result.sessionsScanned} 个会话`
      : `Scanned ${result.sessionsScanned} session(s)`;
    return locale === "zh"
      ? `未找到包含「${result.query}」的聊天记录。\n${scope}。`
      : `No chat history matches for "${result.query}".\n${scope}.`;
  }

  const header = locale === "zh"
    ? `🔍 找到 ${result.matches.length} 条匹配「${result.query}」${result.truncated ? "（结果已截断，可加大 --limit）" : ""}`
    : `🔍 ${result.matches.length} match(es) for "${result.query}"${result.truncated ? " (truncated — try a higher --limit)" : ""}`;

  const lines = [header, ""];
  result.matches.forEach((match, index) => {
    lines.push(formatMatchLine(match, index + 1, { locale, includeProject }));
    lines.push("");
  });

  lines.push(
    locale === "zh"
      ? "提示：在 Web UI 中打开对应会话后，可用 /search 结果中的片段定位消息。"
      : "Tip: open the session in the Web UI to jump to the matched message.",
  );

  return lines.join("\n").trimEnd();
}

function formatMatchLine(
  match: ChatHistorySearchMatch,
  index: number,
  options: { locale: "zh" | "en"; includeProject: boolean },
): string {
  const roleLabel = match.role === "user"
    ? (options.locale === "zh" ? "用户" : "user")
    : (options.locale === "zh" ? "助手" : "assistant");
  const shortId = shortenId(match.sessionId);
  const when = formatWhen(match.createdAt, options.locale);
  const projectSuffix = options.includeProject && match.projectKey
    ? ` · ${basename(match.projectKey)}`
    : "";

  return [
    `${index}. **${match.sessionTitle}** (\`${shortId}\`)${projectSuffix}`,
    `   ${roleLabel} · ${when}`,
    `   > ${match.snippet}`,
  ].join("\n");
}

function shortenId(sessionId: string): string {
  if (sessionId.length <= 12) return sessionId;
  return `${sessionId.slice(0, 8)}…`;
}

function formatWhen(createdAt: string, locale: "zh" | "en"): string {
  if (!createdAt) {
    return locale === "zh" ? "未知时间" : "unknown time";
  }
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) {
    return createdAt;
  }
  return date.toLocaleString(locale === "zh" ? "zh-CN" : "en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function basename(value: string): string {
  const parts = value.split(/[\\/]/);
  return parts[parts.length - 1] || value;
}
