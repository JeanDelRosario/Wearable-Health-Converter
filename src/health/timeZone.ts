const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let result = formatters.get(zone);
  if (!result) {
    result = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    formatters.set(zone, result);
  }
  return result;
}

export function validateTimeZone(zone: string): boolean {
  try { formatter(zone); return true; } catch { return false; }
}

export function dateInTimeZone(instant: number, zone: string): string {
  const parts = Object.fromEntries(formatter(zone).formatToParts(instant).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function midnightInTimeZone(date: string, zone: string): number {
  const target = Date.parse(`${date}T00:00:00Z`);
  let instant = target;
  for (let i = 0; i < 4; i++) {
    const p = Object.fromEntries(formatter(zone).formatToParts(instant).map((v) => [v.type, v.value]));
    const localAsUtc = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    const correction = target - localAsUtc;
    instant += correction;
    if (!correction) break;
  }
  return instant;
}

export function nextDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}
