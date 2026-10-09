import { getCalendarDates } from './dateRange';
import { SUMMARY_TYPE_ORDER, type SupportedTypeKey } from './measurementTypes';
import type { CsvSummaryRow } from './csv';
import type { ImportWarning, ProcessingOptions } from './models';
import { csvObjectConsumer, JsonArrayStreamParser } from './streamingParsers';
import { dateInTimeZone } from './timeZone';

type Dataset = 'steps' | 'legacySteps' | 'rhr' | 'legacyRhr' | 'hrv' | 'legacyHrv' | 'temperature' | 'legacyTemperature' | 'deviation' | 'sleep';
type Value = { value: number; source: string; measurementType: string };
type Sleep = { date: string; start: string; end: string; minutes: number; source: string };
type TextConsumer = { push(text: string): void; finish(): void };

function numeric(value: unknown): number | undefined {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') return;
  const n = Number(value); return Number.isFinite(n) ? n : undefined;
}
function dailyDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) return;
  const date = value.slice(0, 10);
  const instant = Date.parse(`${date}T00:00:00Z`);
  if (Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === date) return date;
}
function legacyInstant(value: unknown): number | undefined {
  if (typeof value !== 'string') return;
  const match = /^(\d{2})\/(\d{2})\/(\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(value);
  if (!match) return;
  const text = `20${match[3]}-${match[1]}-${match[2]}T${match[4]}Z`;
  const result = Date.parse(text);
  if (Number.isFinite(result) && new Date(result).toISOString().slice(0, 19) === text.slice(0, 19)) return result;
}

export class GoogleHealthImporter {
  readonly warnings: ImportWarning[] = [];
  recognizedEntries = 0;
  recordsMatched = 0;
  private present = new Set<Dataset>();
  private values = new Map<Dataset, Map<string, Value>>();
  private conflicts = new Map<Dataset, Set<string>>();
  private seenSteps = new Map<Dataset, Map<number, number>>();
  private sleeps = new Map<string, Sleep>();
  private sleepConflicts = new Set<string>();
  private duplicateSleeps = 0;
  private invalidRecords = 0;
  private missingBaselines = 0;
  private zone: string;

  constructor(private readonly options: ProcessingOptions) {
    this.zone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  /** Only whitelisted metric files are inflated; irrelevant Takeout content is skipped. */
  consumerForEntry(path: string): ((bytes: Uint8Array, final: boolean) => void) | undefined {
    const normalized = path.replaceAll('\\', '/');
    const name = normalized.split('/').pop()!.toLowerCase();
    const lower = normalized.toLowerCase();
    const current = /(?:^|\/)physical activity_googledata\//.test(lower);
    const global = /(?:^|\/)global export data\//.test(lower);
    const hrv = /(?:^|\/)heart rate variability\//.test(lower);
    const temperature = /(?:^|\/)temperature\//.test(lower);
    let dataset: Dataset | undefined;
    let consumer: TextConsumer | undefined;
    const selected = (key: SupportedTypeKey) => this.options.selectedTypes.includes(key);
    const tempSelected = selected('wristTemperature') || selected('temperatureDeviation');
    const source = `Google/Fitbit: ${normalized}`;
    const csv = (required: string[], callback: (row: Record<string, string>) => void) => csvObjectConsumer(required, callback);

    if (current && /^steps_\d{4}-\d{2}-\d{2}\.csv$/.test(name) && selected('stepCount')) {
      dataset = 'steps';
      consumer = csv(['timestamp', 'steps', 'data source'], (r) => this.addStep('steps', /(?:Z|[+-]\d{2}:\d{2})$/.test(r.timestamp) ? Date.parse(r.timestamp) : NaN, r.steps, source));
    } else if (current && name === 'daily_resting_heart_rate.csv' && selected('restingHeartRate')) {
      dataset = 'rhr';
      consumer = csv(['timestamp', 'beats per minute'], (r) => this.addDaily('rhr', r.timestamp, r['beats per minute'], source, 'resting_heart_rate;provided_daily_summary', true));
    } else if (current && name === 'daily_heart_rate_variability.csv' && selected('heartRateVariability')) {
      dataset = 'hrv';
      consumer = csv(['timestamp', 'average heart rate variability milliseconds'], (r) => this.addDaily('hrv', r.timestamp, r['average heart rate variability milliseconds'], source, 'heart_rate_variability_rmssd;provided_sleep_summary', true));
    } else if (current && name === 'daily_sleep_temperature_derivations.csv' && tempSelected) {
      dataset = 'temperature';
      consumer = csv(['timestamp', 'nightly temperature celsius', 'baseline temperature celsius'], (r) => {
        const nightly = numeric(r['nightly temperature celsius']);
        const baseline = numeric(r['baseline temperature celsius']);
        this.addDaily('temperature', r.timestamp, nightly, source, 'nightly_skin_temperature;provided_sleep_summary');
        if (nightly !== undefined && baseline !== undefined) {
          this.addDaily('deviation', r.timestamp, nightly - baseline, source, 'nightly_skin_temperature_deviation;nightly_minus_exported_baseline');
        } else if (this.inRange(dailyDate(r.timestamp)) && selected('temperatureDeviation')) this.missingBaselines++;
      });
    } else if (global && /^sleep-\d{4}-\d{2}-\d{2}\.json$/.test(name) && selected('sleepAnalysis')) {
      dataset = 'sleep'; consumer = new JsonArrayStreamParser((r) => this.addSleep(r, source));
    } else if (global && /^steps-\d{4}-\d{2}-\d{2}\.json$/.test(name) && selected('stepCount')) {
      dataset = 'legacySteps'; consumer = new JsonArrayStreamParser((r) => this.addStep('legacySteps', legacyInstant(r.dateTime), r.value, source));
    } else if (global && /^resting_heart_rate-\d{4}-\d{2}-\d{2}\.json$/.test(name) && selected('restingHeartRate')) {
      dataset = 'legacyRhr'; consumer = new JsonArrayStreamParser((r) => {
        const instant = legacyInstant(r.dateTime);
        const value = r.value && typeof r.value === 'object' ? (r.value as Record<string, unknown>).value : undefined;
        // Zero-valued legacy placeholders represent missing RHR, not a measurement.
        if (numeric(value) === 0) return;
        this.addDaily('legacyRhr', instant === undefined ? undefined : new Date(instant).toISOString(), value, source, 'resting_heart_rate;legacy_provided_daily_summary', true);
      });
    } else if (hrv && /^daily heart rate variability summary - \d{4}-\d{2}-\d{2}\.csv$/.test(name) && selected('heartRateVariability')) {
      dataset = 'legacyHrv'; consumer = csv(['timestamp', 'rmssd'], (r) => this.addDaily('legacyHrv', r.timestamp, r.rmssd, source, 'heart_rate_variability_rmssd;legacy_provided_sleep_summary', true));
    } else if (temperature && /^computed temperature - \d{4}-\d{2}-\d{2}\.csv$/.test(name) && tempSelected) {
      dataset = 'legacyTemperature'; consumer = csv(['type', 'sleep_end', 'nightly_temperature'], (r) => {
        if (!['IDT', 'ACST'].includes(r.type)) { if (this.inRange(dailyDate(r.sleep_end))) this.invalidRecords++; return; }
        this.addDaily('legacyTemperature', r.sleep_end, r.nightly_temperature, source, `nightly_temperature_${r.type.toLowerCase()};legacy_provided_sleep_summary`);
      });
    }
    if (!consumer || !dataset) return;
    this.present.add(dataset); this.recognizedEntries++;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    return (bytes, final) => {
      consumer!.push(decoder.decode(bytes, { stream: !final }));
      if (final) consumer!.finish();
    };
  }

  finish(): CsvSummaryRow[] {
    if (!this.recognizedEntries) throw new Error('No supported Apple Health or Google/Fitbit metric files found in this ZIP.');
    const chosen: Partial<Record<SupportedTypeKey, Dataset>> = {
      stepCount: this.present.has('steps') ? 'steps' : 'legacySteps',
      restingHeartRate: this.present.has('rhr') ? 'rhr' : 'legacyRhr',
      heartRateVariability: this.present.has('hrv') ? 'hrv' : 'legacyHrv',
      wristTemperature: this.present.has('temperature') ? 'temperature' : 'legacyTemperature',
      temperatureDeviation: 'deviation', sleepAnalysis: 'sleep'
    };
    for (const [newer, older] of [['rhr', 'legacyRhr'], ['hrv', 'legacyHrv'], ['temperature', 'legacyTemperature']] as const) {
      if (!this.present.has(newer) || !this.present.has(older)) continue;
      let differences = 0;
      for (const [date, item] of this.values.get(newer) ?? []) {
        const old = this.values.get(older)?.get(date);
        if (old && Math.abs(item.value - old.value) > 0.001) differences++;
      }
      if (differences) this.warnings.push({ code: 'preferred_google', detail: `${newer}: ${differences}` });
    }
    if (this.duplicateSleeps) this.warnings.push({ code: 'duplicate_sleep', detail: String(this.duplicateSleeps) });
    if (this.missingBaselines) this.warnings.push({ code: 'missing_baseline', detail: String(this.missingBaselines) });
    if (this.invalidRecords) this.warnings.push({ code: 'invalid_records', detail: String(this.invalidRecords) });
    if (this.present.has('legacySteps') && !this.present.has('steps')) this.warnings.push({ code: 'legacy_step_timezone' });
    if (!this.present.has('temperature') && this.present.has('legacyTemperature') && this.options.selectedTypes.includes('temperatureDeviation')) this.warnings.push({ code: 'legacy_no_baseline' });
    const rows: CsvSummaryRow[] = [];
    for (const key of SUMMARY_TYPE_ORDER) {
      if (!this.options.selectedTypes.includes(key)) continue;
      const dataset = chosen[key]!;
      if (!this.present.has(dataset) && key !== 'temperatureDeviation') this.warnings.push({ code: 'missing_metric', detail: key });
      if ((this.conflicts.get(dataset)?.size ?? 0) > 0) this.warnings.push({ code: 'conflicting_values', detail: `${key}: ${this.conflicts.get(dataset)!.size}` });
      for (const date of getCalendarDates(this.options.startDate ?? '', this.options.endDate ?? '')) {
        const item = key === 'sleepAnalysis' ? this.sleepValue(date) : this.conflicts.get(dataset)?.has(date) ? undefined : this.values.get(dataset)?.get(date);
        const definition = {
          sleepAnalysis: ['Sleep duration', 'min', 'sleep_duration;sum_minutes_asleep'],
          stepCount: ['Steps', 'steps', `step_count;sum_per_minute;timezone=${this.zone}`],
          heartRateVariability: ['HRV', 'ms', 'heart_rate_variability_rmssd'],
          restingHeartRate: ['Resting heart rate', 'bpm', 'resting_heart_rate'],
          wristTemperature: ['Nightly temperature', '°C', 'nightly_skin_temperature'],
          temperatureDeviation: ['Temperature deviation', '°C', 'nightly_skin_temperature_deviation']
        }[key];
        rows.push({ category: definition[0], date, unit: definition[1], value: item ? this.format(key, item.value) : '', source: item?.source ?? 'Google/Fitbit', measurementType: item?.measurementType ?? definition[2] });
      }
    }
    if (this.sleepConflicts.size) this.warnings.push({ code: 'conflicting_sleep', detail: [...this.sleepConflicts].sort().join(', ') });
    if (!rows.some((r) => r.value !== '')) this.warnings.push({ code: 'no_measurements' });
    return rows;
  }

  private format(key: SupportedTypeKey, value: number): string {
    if (key === 'stepCount' || key === 'sleepAnalysis') return String(Math.round(value));
    return value.toFixed(key === 'wristTemperature' || key === 'temperatureDeviation' ? 2 : 3).replace(/\.?0+$/, '');
  }
  private inRange(date: string | undefined): date is string {
    return !!date && (!this.options.startDate || date >= this.options.startDate) && (!this.options.endDate || date <= this.options.endDate);
  }
  private map(dataset: Dataset): Map<string, Value> {
    if (!this.values.has(dataset)) this.values.set(dataset, new Map());
    return this.values.get(dataset)!;
  }
  private markConflict(dataset: Dataset, date: string): void {
    if (!this.conflicts.has(dataset)) this.conflicts.set(dataset, new Set());
    this.conflicts.get(dataset)!.add(date);
  }
  private addDaily(dataset: Dataset, timestamp: unknown, value: unknown, source: string, measurementType: string, positive = false): void {
    const date = dailyDate(timestamp);
    if (!this.inRange(date)) return;
    const n = numeric(value);
    if (n === undefined || (positive && n <= 0)) { this.invalidRecords++; this.markConflict(dataset, date); return; }
    const previous = this.map(dataset).get(date);
    if (previous && Math.abs(previous.value - n) > 1e-8) this.markConflict(dataset, date);
    else this.map(dataset).set(date, { value: n, source, measurementType });
    this.recordsMatched++;
  }
  private addStep(dataset: Dataset, instant: number | undefined, value: unknown, source: string): void {
    if (instant === undefined || !Number.isFinite(instant)) { this.invalidRecords++; return; }
    const date = dateInTimeZone(instant, this.zone);
    if (!this.inRange(date)) return;
    const n = numeric(value);
    if (n === undefined || n < 0 || !Number.isInteger(n)) { this.markConflict(dataset, date); this.invalidRecords++; return; }
    if (!this.seenSteps.has(dataset)) this.seenSteps.set(dataset, new Map());
    const seen = this.seenSteps.get(dataset)!;
    const prior = seen.get(instant);
    if (prior !== undefined) { if (prior !== n) this.markConflict(dataset, date); return; }
    seen.set(instant, n);
    const map = this.map(dataset);
    map.set(date, { value: (map.get(date)?.value ?? 0) + n, source, measurementType: `step_count;sum_per_minute;timezone=${this.zone}` });
    this.recordsMatched++;
  }
  private addSleep(record: Record<string, unknown>, source: string): void {
    const date = dailyDate(record.dateOfSleep);
    if (!this.inRange(date)) return;
    const minutes = numeric(record.minutesAsleep);
    const start = record.startTime, end = record.endTime;
    if (minutes === undefined || minutes < 0 || typeof start !== 'string' || typeof end !== 'string' || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || start >= end || record.logId === undefined) {
      this.invalidRecords++; this.sleepConflicts.add(date); return;
    }
    const sleep = { date, start, end, minutes, source };
    const id = String(record.logId);
    const old = this.sleeps.get(id);
    if (old) {
      if (old.date === date && old.start === start && old.end === end && old.minutes === minutes) this.duplicateSleeps++;
      else { this.sleepConflicts.add(old.date); this.sleepConflicts.add(date); }
    } else this.sleeps.set(id, sleep);
    this.recordsMatched++;
  }
  private sleepValue(date: string): Value | undefined {
    if (this.sleepConflicts.has(date)) return;
    const sleeps = [...this.sleeps.values()].filter((r) => r.date === date).sort((a, b) => a.start.localeCompare(b.start));
    if (!sleeps.length) return;
    if (sleeps.some((r, i) => i > 0 && r.start < sleeps[i - 1].end)) { this.sleepConflicts.add(date); return; }
    return { value: sleeps.reduce((sum, r) => sum + r.minutes, 0), source: [...new Set(sleeps.map((r) => r.source))].join('; '), measurementType: 'sleep_duration;sum_minutes_asleep;dateOfSleep' };
  }
}
