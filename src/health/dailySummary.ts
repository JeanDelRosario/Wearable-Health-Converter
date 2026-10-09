import { getCalendarDates } from './dateRange';
import type { HealthRecord } from './models';
import type { SupportedTypeKey } from './appleHealthTypes';
import type { CsvSummaryRow } from './csv';
import { SUMMARY_TYPE_ORDER } from './measurementTypes';
import { dateInTimeZone, midnightInTimeZone, nextDate } from './timeZone';

type NumericDailyValue = { sum: number; count: number };
type SleepSegment = { startDate: string; endDate: string; value: string };
type StepSourceKind = 'watch' | 'iphone' | 'other';
type StepInterval = { start: number; end: number; count: number; priority: number; sourceKind: StepSourceKind };

const WATCH_GUARD_MILLISECONDS = 6 * 60 * 1_000;

export interface DailySummary {
  numericValues: Map<SupportedTypeKey, Map<string, NumericDailyValue>>;
  sleepSegments: Map<string, SleepSegment[]>;
  stepIntervals: StepInterval[];
}

export function createDailySummary(): DailySummary {
  return { numericValues: new Map(), sleepSegments: new Map(), stepIntervals: [] };
}

export function addRecordToDailySummary(summary: DailySummary, record: HealthRecord): void {
  if (record.typeKey === 'sleepAnalysis') {
    const date = calendarDate(record.endDate);
    if (date) {
      const segments = summary.sleepSegments.get(date) ?? [];
      segments.push({ startDate: record.startDate, endDate: record.endDate, value: record.value });
      summary.sleepSegments.set(date, segments);
    }
    return;
  }
  if (record.typeKey === 'stepCount') {
    addStepInterval(summary, record);
    return;
  }

  const date = calendarDate(record.typeKey === 'wristTemperature' ? record.endDate || record.startDate : record.startDate);
  let value = record.value.trim() ? Number(record.value) : NaN;
  if (record.typeKey === 'wristTemperature') {
    if (record.unit === 'degF' || record.unit === '°F') value = (value - 32) * 5 / 9;
    else if (!['degC', '°C'].includes(record.unit)) return;
  }
  if (!date || !Number.isFinite(value)) return;
  const typeValues = summary.numericValues.get(record.typeKey) ?? new Map<string, NumericDailyValue>();
  const current = typeValues.get(date) ?? { sum: 0, count: 0 };
  current.sum += value;
  current.count += 1;
  typeValues.set(date, current);
  summary.numericValues.set(record.typeKey, typeValues);
}

export function createDailySummaryRows(summary: DailySummary, selectedTypes: SupportedTypeKey[], startDate: string, endDate: string, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): CsvSummaryRow[] {
  const rows: CsvSummaryRow[] = [];
  const dates = getCalendarDates(startDate, endDate);
  const stepTotals = selectedTypes.includes('stepCount') ? calculateStepTotals(summary.stepIntervals, startDate, endDate, timeZone) : new Map<string, number>();
  for (const typeKey of SUMMARY_TYPE_ORDER) {
    if (!selectedTypes.includes(typeKey)) continue;
    for (const date of dates) rows.push(toSummaryRow(summary, typeKey, date, stepTotals));
  }
  return rows;
}

function toSummaryRow(summary: DailySummary, typeKey: SupportedTypeKey, date: string, stepTotals: Map<string, number>): CsvSummaryRow {
  if (typeKey === 'sleepAnalysis') {
    const minutes = getSleepDurationMinutes(summary.sleepSegments.get(date) ?? []);
    return { category: 'Sleep duration', date, value: minutes === undefined ? '' : String(minutes), unit: 'min' };
  }
  if (typeKey === 'stepCount') {
    const total = stepTotals.get(date);
    return { category: 'Steps', date, value: total === undefined ? '' : String(Math.round(total)), unit: 'steps' };
  }
  if (typeKey === 'temperatureDeviation') {
    // Apple's Health-app baseline is not supplied by this XML parser. Never invent it.
    return { category: 'Temperature deviation', date, value: '', unit: '°C' };
  }

  const dailyValue = summary.numericValues.get(typeKey)?.get(date);
  if (typeKey === 'wristTemperature') {
    return { category: 'Nightly temperature', date, value: dailyValue ? (dailyValue.sum / dailyValue.count).toFixed(2) : '', unit: '°C' };
  }
  if (typeKey === 'heartRateVariability') {
    return { category: 'HRV', date, value: dailyValue ? formatAverage(dailyValue) : '', unit: 'ms' };
  }
  return { category: 'Resting heart rate', date, value: dailyValue ? formatAverage(dailyValue) : '', unit: 'bpm' };
}

function addStepInterval(summary: DailySummary, record: HealthRecord): void {
  const start = parseAppleHealthDate(record.startDate);
  const parsedEnd = parseAppleHealthDate(record.endDate);
  const count = Number(record.value);
  if (start === undefined || !Number.isFinite(count) || count < 0) return;
  summary.stepIntervals.push({
    start,
    end: parsedEnd !== undefined && parsedEnd > start ? parsedEnd : start + 1,
    count,
    priority: stepSourcePriority(record),
    sourceKind: stepSourceKind(record)
  });
}

function calculateStepTotals(intervals: StepInterval[], startDate: string, endDate: string, timeZone: string): Map<string, number> {
  const periodStart = midnightInTimeZone(startDate, timeZone);
  const periodEnd = midnightInTimeZone(nextDate(endDate), timeZone);
  if (Number.isNaN(periodStart) || Number.isNaN(periodEnd) || periodEnd <= periodStart) return new Map();

  const activeIntervals = intervals
    .filter((interval) => interval.end > periodStart && interval.start < periodEnd);
  const watchIntervals = activeIntervals.filter((interval) => interval.sourceKind === 'watch');
  if (watchIntervals.length) {
    const acceptedFallbackIntervals = activeIntervals.filter((interval) =>
      interval.sourceKind !== 'watch' && !overlapsWatchGuard(interval, watchIntervals)
    );
    return sumIntervalsByDay([...watchIntervals, ...acceptedFallbackIntervals], periodStart, periodEnd, timeZone);
  }

  return calculateFallbackStepTotals(activeIntervals, periodStart, periodEnd, timeZone);
}

function overlapsWatchGuard(interval: StepInterval, watchIntervals: StepInterval[]): boolean {
  return watchIntervals.some((watch) =>
    watch.start - WATCH_GUARD_MILLISECONDS < interval.end && watch.end + WATCH_GUARD_MILLISECONDS > interval.start
  );
}

function sumIntervalsByDay(intervals: StepInterval[], periodStart: number, periodEnd: number, timeZone: string): Map<string, number> {
  const totals = new Map<string, number>();
  for (const interval of intervals) {
    let segmentStart = Math.max(interval.start, periodStart);
    const clippedEnd = Math.min(interval.end, periodEnd);
    while (segmentStart < clippedEnd) {
      const date = dateInTimeZone(segmentStart, timeZone);
      const segmentEnd = dateInTimeZone(clippedEnd - 1, timeZone) === date ? clippedEnd : Math.min(clippedEnd, midnightInTimeZone(nextDate(date), timeZone));
      const value = (interval.count / (interval.end - interval.start)) * (segmentEnd - segmentStart);
      totals.set(date, (totals.get(date) ?? 0) + value);
      segmentStart = segmentEnd;
    }
  }
  return totals;
}

function calculateFallbackStepTotals(activeIntervals: StepInterval[], periodStart: number, periodEnd: number, timeZone: string): Map<string, number> {
  const boundaries = new Set<number>([periodStart, periodEnd]);
  for (const interval of activeIntervals) {
    boundaries.add(Math.max(interval.start, periodStart));
    boundaries.add(Math.min(interval.end, periodEnd));
  }
  for (let midnight = periodStart; midnight < periodEnd;) {
    boundaries.add(midnight);
    midnight = midnightInTimeZone(nextDate(dateInTimeZone(midnight, timeZone)), timeZone);
  }

  const totals = new Map<string, number>();
  const points = [...boundaries].sort((left, right) => left - right);
  for (let index = 1; index < points.length; index += 1) {
    const slotStart = points[index - 1];
    const slotEnd = points[index];
    const selected = selectStepInterval(activeIntervals, slotStart, slotEnd);
    if (!selected) continue;
    const value = (selected.count / (selected.end - selected.start)) * (slotEnd - slotStart);
    const date = dateInTimeZone(slotStart, timeZone);
    totals.set(date, (totals.get(date) ?? 0) + value);
  }
  return totals;
}

function selectStepInterval(intervals: StepInterval[], slotStart: number, slotEnd: number): StepInterval | undefined {
  const candidates = intervals.filter((interval) => interval.start < slotEnd && interval.end > slotStart);
  if (!candidates.length) return undefined;
  const highestPriority = Math.max(...candidates.map((interval) => interval.priority));
  return candidates
    .filter((interval) => interval.priority === highestPriority)
    .reduce((winner, interval) => interval.count / (interval.end - interval.start) > winner.count / (winner.end - winner.start) ? interval : winner);
}

function stepSourcePriority(record: HealthRecord): number {
  const source = `${record.sourceName} ${record.device}`;
  if (/\b(?:apple\s*)?watch\b/i.test(source)) return 3;
  if (/\biphone\b/i.test(source)) return 1;
  return 2;
}

function stepSourceKind(record: HealthRecord): StepSourceKind {
  const source = `${record.sourceName} ${record.device}`;
  if (/\b(?:apple\s*)?watch\b/i.test(source)) return 'watch';
  if (/\biphone\b/i.test(source)) return 'iphone';
  return 'other';
}

function formatAverage(value: NumericDailyValue): string {
  const average = value.sum / value.count;
  return Number.isInteger(average) ? String(average) : average.toFixed(1);
}

function calendarDate(value: string): string | undefined {
  const date = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
}

function getSleepDurationMinutes(segments: SleepSegment[]): number | undefined {
  const intervals = segments
    .filter((segment) => !segment.value.includes('Awake') && !segment.value.includes('InBed'))
    .map((segment) => [parseAppleHealthDate(segment.startDate), parseAppleHealthDate(segment.endDate)] as const)
    .filter((interval): interval is readonly [number, number] => interval[0] !== undefined && interval[1] !== undefined && interval[1] > interval[0])
    .sort((left, right) => left[0] - right[0]);
  if (!intervals.length) return undefined;

  let total = 0;
  let activeStart = intervals[0][0];
  let activeEnd = intervals[0][1];
  for (const [start, end] of intervals.slice(1)) {
    if (start > activeEnd) {
      total += activeEnd - activeStart;
      activeStart = start;
      activeEnd = end;
    } else {
      activeEnd = Math.max(activeEnd, end);
    }
  }
  return Math.round((total + activeEnd - activeStart) / 60_000);
}

function parseAppleHealthDate(value: string): number | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+([+-]\d{2})(\d{2})$/.exec(value);
  if (!match) return undefined;
  const timestamp = Date.parse(`${match[1]}T${match[2]}${match[3]}:${match[4]}`);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}
