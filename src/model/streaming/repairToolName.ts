/**
 * Fuzzy tool name repair — inspired by Hermes Agent's `repair_tool_call`
 * and OpenCode's `experimental_repairToolCall` alias resolution.
 *
 * Attempts to match a raw tool name to a valid tool name using progressively
 * looser matching strategies.
 */

const BUILTIN_ALIASES: Record<string, string> = {
  search: "grep",
  find: "glob",
  cat: "read",
  run: "bash",
  shell: "bash",
  todo: "todowrite",
  fetch: "webfetch",
  execute: "bash",
  write_file: "write",
  read_file: "read",
  list_files: "glob",
  edit: "str_replace",
};

export type RepairResult = {
  name: string;
  wasRepaired: boolean;
};

export function repairToolName(
  rawName: string,
  validNames: Set<string>,
  userAliases?: Record<string, string>,
): RepairResult | null {
  if (!rawName || validNames.size === 0) return null;

  const trimmed = rawName.trim();
  if (validNames.has(trimmed)) {
    return { name: trimmed, wasRepaired: false };
  }

  const lowered = trimmed.toLowerCase();
  if (validNames.has(lowered)) {
    return { name: lowered, wasRepaired: true };
  }

  const normalized = normalize(trimmed);
  if (validNames.has(normalized)) {
    return { name: normalized, wasRepaired: true };
  }

  const snaked = camelToSnake(trimmed);
  if (validNames.has(snaked)) {
    return { name: snaked, wasRepaired: true };
  }

  // Strip trailing _tool / -tool / Tool suffix (up to two passes)
  let stripped: string | null = trimmed;
  for (let i = 0; i < 2; i++) {
    stripped = stripToolSuffix(stripped);
    if (!stripped) break;
    const candidates = [stripped, stripped.toLowerCase(), normalize(stripped), camelToSnake(stripped)];
    for (const c of candidates) {
      if (validNames.has(c)) {
        return { name: c, wasRepaired: true };
      }
    }
  }

  // User-configured aliases take priority over builtins
  const combinedAliases = { ...BUILTIN_ALIASES, ...userAliases };
  const aliasKey = lowered in combinedAliases ? lowered : normalized in combinedAliases ? normalized : undefined;
  if (aliasKey) {
    const target = combinedAliases[aliasKey]!;
    if (validNames.has(target)) {
      return { name: target, wasRepaired: true };
    }
  }

  // Fuzzy match: find best candidate by Levenshtein distance
  const best = fuzzyMatch(lowered, validNames);
  if (best) {
    return { name: best, wasRepaired: true };
  }

  return null;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[-\s]/g, "_");
}

function camelToSnake(s: string): string {
  return s.replace(/(?<!^)(?=[A-Z])/g, "_").toLowerCase();
}

function stripToolSuffix(s: string | null): string | null {
  if (!s) return null;
  const lc = s.toLowerCase();
  for (const suffix of ["_tool", "-tool", "tool"]) {
    if (lc.endsWith(suffix) && lc.length > suffix.length) {
      return s.slice(0, -suffix.length).replace(/[_-]$/, "");
    }
  }
  return null;
}

function fuzzyMatch(target: string, candidates: Set<string>): string | null {
  let bestName: string | null = null;
  let bestDist = Infinity;

  for (const candidate of candidates) {
    const dist = levenshtein(target, candidate);
    if (dist < bestDist) {
      bestDist = dist;
      bestName = candidate;
    }
  }

  // Only accept if edit distance <= 2 and target is at least 3 chars
  if (bestName && bestDist <= 2 && target.length >= 3) {
    return bestName;
  }
  return null;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);

  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      );
    }
  }

  return dp[m]![n]!;
}
