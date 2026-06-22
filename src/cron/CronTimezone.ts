export function isValidCronTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export function resolveCronTimezone(
  scheduleTimezone?: string,
  taskTimezone?: string,
  configTimezone?: string,
): string {
  for (const timezone of [scheduleTimezone, taskTimezone, configTimezone, "UTC"]) {
    if (timezone && isValidCronTimezone(timezone)) {
      return timezone;
    }
  }
  return "UTC";
}
