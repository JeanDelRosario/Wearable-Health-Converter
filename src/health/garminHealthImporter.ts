import { getCalendarDates } from './dateRange';
import { SUMMARY_TYPE_ORDER, type SupportedTypeKey } from './measurementTypes';
import { JsonArrayStreamParser } from './streamingParsers';
import type { CsvSummaryRow } from './csv';
import type { ImportWarning, ProcessingOptions } from './models';

type JsonRecord = Record<string, unknown>;
type SleepSession = { start: number; end: number; seconds: number };
const definitions: Record<SupportedTypeKey, { category: string; unit: string; source: string; measurementType: string }> = {
  stepCount: { category: 'Steps', unit: 'steps', source: 'Garmin Connect: UDSFile', measurementType: 'step_count;totalSteps;provided_daily_summary;exported_calendar_date' },
  restingHeartRate: { category: 'Resting heart rate', unit: 'bpm', source: 'Garmin Connect: UDSFile', measurementType: 'resting_heart_rate;currentDayRestingHeartRate;provided_daily_summary;exported_calendar_date' },
  sleepAnalysis: { category: 'Sleep duration', unit: 'min', source: 'Garmin Connect: sleepData', measurementType: 'sleep_duration;sum_deep_light_rem_and_nonoverlapping_naps;exported_calendar_date' },
  heartRateVariability: { category: 'HRV', unit: 'ms', source: 'Garmin Connect: healthStatusData', measurementType: 'heart_rate_variability;garmin_health_status_hrv;provided_sleep_summary;method_not_exported' },
  wristTemperature: { category: 'Nightly temperature', unit: '°C', source: 'Garmin Connect: healthStatusData', measurementType: 'nightly_skin_temperature;absolute_temperature_not_available' },
  temperatureDeviation: { category: 'Temperature deviation', unit: '°C', source: 'Garmin Connect: healthStatusData', measurementType: 'nightly_skin_temperature_deviation;SKIN_TEMP_C;provided_sleep_summary;exported_calendar_date' }
};

export class GarminHealthImporter {
  readonly warnings: ImportWarning[] = [];
  recognizedEntries = 0;
  recordsMatched = 0;
  private values = new Map<SupportedTypeKey, Map<string, number>>();
  private conflicts = new Map<SupportedTypeKey, Set<string>>();
  private sleeps = new Map<string, Map<string, SleepSession>>();
  private inconsistentSleepWindows = new Set<string>();
  private invalidRecords = 0;

  constructor(private readonly options: ProcessingOptions) {}

  /** Read only daily summary datasets, never account profiles or nested workout FIT archives. */
  consumerForEntry(path: string): ((bytes: Uint8Array, final: boolean) => void) | undefined {
    const lower = path.replaceAll('\\', '/').toLowerCase();
    let emit: ((record: JsonRecord) => void) | undefined;
    if (/(?:^|\/)di_connect\/di-connect-aggregator\/udsfile_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.json$/.test(lower)) emit = r => this.addDaily(r);
    else if (/(?:^|\/)di_connect\/di-connect-wellness\/[^/]+_sleepdata\.json$/.test(lower)) emit = r => this.addSleep(r);
    else if (/(?:^|\/)di_connect\/di-connect-wellness\/[^/]+_healthstatusdata\.json$/.test(lower)) emit = r => this.addHealthStatus(r);
    if (!emit) return;
    this.recognizedEntries++;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const parser = new JsonArrayStreamParser(emit);
    return (bytes, final) => {
      parser.push(decoder.decode(bytes, { stream: !final }));
      if (final) parser.finish();
    };
  }

  finish(): CsvSummaryRow[] {
    const rows: CsvSummaryRow[] = [];
    for (const key of SUMMARY_TYPE_ORDER) {
      if (!this.selected(key)) continue;
      const conflicts = this.conflicts.get(key);
      if (conflicts?.size) this.warnings.push({ code: key === 'sleepAnalysis' ? 'conflicting_sleep' : 'conflicting_values', detail: `${definitions[key].category}: ${conflicts.size}` });
      let available = false;
      for (const date of getCalendarDates(this.options.startDate!, this.options.endDate!)) {
        let value: number | undefined;
        if (!conflicts?.has(date)) {
          value = key === 'sleepAnalysis' ? this.sleepMinutes(date) : this.values.get(key)?.get(date);
        }
        if (value !== undefined) available = true;
        rows.push({ ...definitions[key], date, value: value === undefined ? '' : String(value) });
      }
      if (key === 'wristTemperature') this.warnings.push({ code: 'garmin_no_absolute_temperature' });
      else if (!available) this.warnings.push({ code: 'missing_metric', detail: definitions[key].category });
    }
    if (this.invalidRecords) this.warnings.push({ code: 'invalid_records', detail: String(this.invalidRecords) });
    if (this.inconsistentSleepWindows.size) this.warnings.push({ code: 'garmin_sleep_window_mismatch', detail: String(this.inconsistentSleepWindows.size) });
    if (!rows.some(r => r.value !== '')) this.warnings.push({ code: 'no_measurements' });
    return rows;
  }

  private selected(key: SupportedTypeKey): boolean { return this.options.selectedTypes.includes(key); }

  private inRange(value: unknown): value is string {
    return validDate(value) && value >= this.options.startDate! && value <= this.options.endDate!;
  }

  private put(key: SupportedTypeKey, date: string, value: number): void {
    const values = this.values.get(key) ?? new Map<string, number>();
    const existing = values.get(date);
    if (existing !== undefined && existing !== value) this.conflict(key, date);
    else values.set(date, value);
    this.values.set(key, values);
    this.recordsMatched++;
  }

  private conflict(key: SupportedTypeKey, date: string): void {
    const dates = this.conflicts.get(key) ?? new Set<string>();
    dates.add(date); this.conflicts.set(key, dates);
  }

  private addDaily(r: JsonRecord): void {
    if (!this.inRange(r.calendarDate)) return;
    for (const [key, field, positive] of [
      ['stepCount', 'totalSteps', false], ['restingHeartRate', 'currentDayRestingHeartRate', true]
    ] as const) {
      if (!this.selected(key) || r[field] === undefined || r[field] === null) continue;
      const value = numeric(r[field]);
      if (value === undefined || (positive ? value <= 0 : value < 0) || (key === 'stepCount' && !Number.isInteger(value))) this.invalidRecords++;
      else this.put(key, r.calendarDate, value);
    }
  }

  private addHealthStatus(r: JsonRecord): void {
    if (!this.inRange(r.calendarDate) || !Array.isArray(r.metrics)) return;
    for (const metric of r.metrics) {
      if (!isRecord(metric)) continue;
      const key = metric.type === 'HRV' ? 'heartRateVariability' : metric.type === 'SKIN_TEMP_C' ? 'temperatureDeviation' : undefined;
      // HR here is the overnight heart-rate summary, not daily resting heart rate.
      if (!key || !this.selected(key) || metric.status === 'UNKNOWN' || metric.value === undefined || metric.value === null) continue;
      const value = numeric(metric.value);
      if (value === undefined || (key === 'heartRateVariability' && value <= 0)) this.invalidRecords++;
      else this.put(key, r.calendarDate, value);
    }
  }

  private addSleep(r: JsonRecord): void {
    if (!this.selected('sleepAnalysis') || !this.inRange(r.calendarDate)) return;
    if (r.sleepWindowConfirmationType !== 'UNCONFIRMED' && ('deepSleepSeconds' in r || 'lightSleepSeconds' in r)) {
      const deep = numeric(r.deepSleepSeconds);
      const light = numeric(r.lightSleepSeconds);
      const rem = r.remSleepSeconds === undefined ? 0 : numeric(r.remSleepSeconds);
      if (deep === undefined || light === undefined || rem === undefined || [deep, light, rem].some(v => v < 0)) this.invalidRecords++;
      else this.addSession(r.calendarDate, deep + light + rem, r.sleepStartTimestampGMT, r.sleepEndTimestampGMT);
    }
    if (Array.isArray(r.napList)) for (const nap of r.napList) {
      if (!isRecord(nap) || !this.inRange(nap.calendarDate ?? r.calendarDate)) continue;
      const seconds = numeric(nap.napTimeSec);
      if (seconds === undefined || seconds < 0) this.invalidRecords++;
      else this.addSession((nap.calendarDate ?? r.calendarDate) as string, seconds, nap.napStartTimestampGMT, nap.napEndTimestampGMT);
    }
  }

  private addSession(date: string, seconds: number, startValue: unknown, endValue: unknown): void {
    const start = garminUtcInstant(startValue);
    const end = garminUtcInstant(endValue);
    if (start === undefined || end === undefined || end <= start) { this.invalidRecords++; return; }
    // Edited Garmin windows can be shorter than the provided stage total. Keep
    // the exported duration, and make the discrepancy visible to researchers.
    if (seconds > (end - start) / 1000 + 1) this.inconsistentSleepWindows.add(date);
    const sessions = this.sleeps.get(date) ?? new Map<string, SleepSession>();
    const id = `${start}/${end}`;
    const same = sessions.get(id);
    if (same) {
      if (same.seconds !== seconds) this.conflict('sleepAnalysis', date);
    } else {
      if ([...sessions.values()].some(s => start < s.end && end > s.start)) this.conflict('sleepAnalysis', date);
      sessions.set(id, { start, end, seconds });
    }
    this.sleeps.set(date, sessions); this.recordsMatched++;
  }

  private sleepMinutes(date: string): number | undefined {
    const sessions = this.sleeps.get(date);
    return sessions?.size ? [...sessions.values()].reduce((sum, s) => sum + s.seconds, 0) / 60 : undefined;
  }
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is JsonRecord { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function garminUtcInstant(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)) return;
  const timestamp = Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}Z`);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}
