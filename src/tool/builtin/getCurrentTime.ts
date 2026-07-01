import type { PilotDeckToolDefinition } from "../protocol/types.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";

export type GetCurrentTimeInput = {
  timezone?: string;
};

export type GetCurrentTimeOutput = {
  timezone: string;
  iso: string;
  local: string;
  date: string;
  weekday: string;
  unixMs: number;
};

export function createGetCurrentTimeTool(): PilotDeckToolDefinition<GetCurrentTimeInput, GetCurrentTimeOutput> {
  return {
    name: "get_current_time",
    title: "Get Current Time",
    description: "Return the current local time for a timezone. Use this before creating cron_create tasks with absolute dates/times such as tonight, tomorrow morning, or next Monday. For simple relative delays like 'in 10 minutes', prefer cron_create with schedule.type='delay' instead of calling this tool.",
    kind: "custom",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        timezone: {
          type: "string",
          description: "IANA timezone, e.g. Asia/Shanghai. Defaults to the host local timezone.",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input, context) => {
      const timezone = input.timezone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      assertValidTimezone(timezone);
      const now = context.now?.() ?? new Date();
      const output: GetCurrentTimeOutput = {
        timezone,
        iso: now.toISOString(),
        local: formatLocalDateTime(now, timezone),
        date: formatLocalDate(now, timezone),
        weekday: formatWeekday(now, timezone),
        unixMs: now.getTime(),
      };
      return {
        content: [{ type: "json", value: output }],
        data: output,
      };
    },
  };
}

function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new PilotDeckToolRuntimeError(
      "tool_execution_failed",
      `Invalid timezone: ${timezone}`,
    );
  }
}

function formatLocalDateTime(date: Date, timezone: string): string {
  const values = dateParts(date, timezone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const offset = formatOffset(date, timezone);
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}${offset}`;
}

function formatLocalDate(date: Date, timezone: string): string {
  const values = dateParts(date, timezone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return `${values.year}-${values.month}-${values.day}`;
}

function formatWeekday(date: Date, timezone: string): string {
  const values = dateParts(date, timezone, { weekday: "long" });
  return values.weekday ?? "";
}

function dateParts(
  date: Date,
  timezone: string,
  options: Intl.DateTimeFormatOptions,
): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone, ...options })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
}

function formatOffset(date: Date, timezone: string): string {
  const value = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "longOffset",
  }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value;
  const match = value?.match(/GMT([+-]\d{2}:\d{2})/);
  return match?.[1] ?? "+00:00";
}
