import { CsvStreamParser } from './streamingParsers';
import { getCalendarDates } from './dateRange';
import { dateInTimeZone } from './timeZone';
import { SUMMARY_TYPE_ORDER, type SupportedTypeKey } from './measurementTypes';
import type { CsvSummaryRow } from './csv';
import type { ImportWarning, ProcessingOptions } from './models';

type Row = Record<string, string>;
type Interval = { start: number; end: number };
type Parent = Interval & { date: string };
type Stage = Interval & { parent: string; asleep: boolean };
type Temperature = Interval & { value: number; baseline?: number };
const datasets = {
  'com.samsung.shealth.step_daily_trend': ['day_time', 'count', 'source_type'],
  'com.samsung.shealth.sleep': ['start_time', 'end_time', 'datauuid'],
  'com.samsung.health.sleep_stage': ['start_time', 'end_time', 'sleep_id', 'stage'],
  'com.samsung.health.skin_temperature': ['start_time', 'end_time', 'temperature'],
  'com.samsung.shealth.vitality_score': ['day_time', 'shrv_value'],
  'com.samsung.health.hrv': ['start_time', 'end_time', 'binning_data']
} as const;
type Dataset = keyof typeof datasets;
const definitions: Record<SupportedTypeKey, { category: string; unit: string; source: string; measurementType: string }> = {
  stepCount: { category: 'Steps', unit: 'steps', source: 'Samsung Health: step_daily_trend', measurementType: 'step_count;source_type_all_minus2;latest_update;exported_day_time' },
  sleepAnalysis: { category: 'Sleep duration', unit: 'min', source: 'Samsung Health: sleep + sleep_stage', measurementType: 'sleep_duration;union_asleep_stages_40002_40003_40004;local_parent_end_date' },
  heartRateVariability: { category: 'HRV', unit: 'ms', source: 'Samsung Health: vitality_score', measurementType: 'heart_rate_variability;sleeping_hrv_summary;shrv_value;method_not_exported' },
  restingHeartRate: { category: 'Resting heart rate', unit: 'bpm', source: 'Samsung Health', measurementType: 'resting_heart_rate;explicit_daily_summary_not_available' },
  wristTemperature: { category: 'Nightly temperature', unit: '°C', source: 'Samsung Health: skin_temperature', measurementType: 'nightly_skin_temperature;mean_exported_session_means;local_sample_end_date' },
  temperatureDeviation: { category: 'Temperature deviation', unit: '°C', source: 'Samsung Health: skin_temperature', measurementType: 'nightly_skin_temperature_deviation;mean_session_temperature_minus_exported_baseline;complete_baseline_coverage' }
};

export class SamsungHealthImporter {
  readonly warnings: ImportWarning[] = [];
  recognizedEntries = 0;
  recordsMatched = 0;
  private steps = new Map<string, Map<string, { value: number; updated?: number }>>();
  private values = new Map<SupportedTypeKey, Map<string, number>>();
  private conflicts = new Map<SupportedTypeKey, Set<string>>();
  private parents = new Map<string, Parent>();
  private stages: Stage[] = [];
  private temperatures = new Map<string, Map<string, Temperature>>();
  private invalidRecords = 0;
  private rawHrvReferences = 0;
  private timezoneFallback = false;

  constructor(private readonly options: ProcessingOptions) {}

  consumerForEntry(path: string): ((bytes: Uint8Array, final: boolean) => void) | undefined {
    const normalized = path.replaceAll('\\', '/');
    const name = normalized.split('/').pop()!.toLowerCase();
    if (/(?:^|\/)__macosx\//i.test(normalized) || name.startsWith('._')) return;
    const dataset = (Object.keys(datasets) as Dataset[]).find(key => name === `${key}.csv` || new RegExp(`^${key.replaceAll('.', '\\.')}\\.\\d{14}(?: \\(\\d+\\))?\\.csv$`).test(name));
    if (!dataset) return;
    this.recognizedEntries++;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let first = true;
    let headers: string[] | undefined;
    const parser = new CsvStreamParser(fields => {
      if (first) {
        first = false;
        if (fields[0].replace(/^\uFEFF/, '') === dataset) return;
      }
      if (!headers) {
        while (fields.at(-1) === '') fields.pop();
        headers = fields.map(value => value.replace(/^\uFEFF/, '').trim().split('.').at(-1)!);
        if (new Set(headers).size !== headers.length || datasets[dataset].some(key => !headers!.includes(key))) throw new Error(`Samsung CSV is missing expected columns for ${dataset}.`);
      } else {
        // Samsung writes a trailing comma after the last data column.
        while (fields.length > headers.length && fields.at(-1) === '') fields.pop();
        if (fields.length !== headers.length) throw new Error('Samsung CSV row has an unexpected number of fields.');
        this.add(dataset, Object.fromEntries(headers.map((key, index) => [key, fields[index]])));
      }
    });
    return (bytes, final) => {
      parser.push(decoder.decode(bytes, { stream: !final }));
      if (final) { parser.finish(); if (!headers) throw new Error('Samsung CSV has no header.'); }
    };
  }

  finish(): CsvSummaryRow[] {
    this.finishSteps(); this.finishSleep(); this.finishTemperature();
    if (this.selected('restingHeartRate')) this.warnings.push({ code: 'samsung_no_resting_heart_rate' });
    if (this.selected('heartRateVariability')) {
      this.warnings.push({ code: 'samsung_hrv_summary_only' });
      if (this.rawHrvReferences) this.warnings.push({ code: 'samsung_hrv_raw_unavailable', detail: String(this.rawHrvReferences) });
    }
    const rows: CsvSummaryRow[] = [];
    for (const key of SUMMARY_TYPE_ORDER) {
      if (!this.selected(key)) continue;
      const conflicts = this.conflicts.get(key);
      if (conflicts?.size) this.warnings.push({ code: key === 'sleepAnalysis' ? 'conflicting_sleep' : 'conflicting_values', detail: `${definitions[key].category}: ${conflicts.size}` });
      let available = false;
      for (const date of getCalendarDates(this.options.startDate!, this.options.endDate!)) {
        const value = conflicts?.has(date) ? undefined : this.values.get(key)?.get(date);
        if (value !== undefined) available = true;
        rows.push({ ...definitions[key], date, value: value === undefined ? '' : key === 'wristTemperature' || key === 'temperatureDeviation' ? value.toFixed(2) : String(value) });
      }
      if (!available && key !== 'restingHeartRate') this.warnings.push({ code: 'missing_metric', detail: definitions[key].category });
    }
    if (this.invalidRecords) this.warnings.push({ code: 'invalid_records', detail: String(this.invalidRecords) });
    if (this.timezoneFallback) this.warnings.push({ code: 'samsung_timezone_fallback' });
    if (!rows.some(row => row.value !== '')) this.warnings.push({ code: 'no_measurements' });
    return rows;
  }

  private selected(key: SupportedTypeKey): boolean { return this.options.selectedTypes.includes(key); }
  private inRange(date: string | undefined): date is string { return !!date && date >= this.options.startDate! && date <= this.options.endDate!; }
  private put(key: SupportedTypeKey, date: string, value: number): void {
    const values = this.values.get(key) ?? new Map<string, number>();
    const prior = values.get(date);
    if (prior !== undefined && prior !== value) this.conflict(key, date);
    else values.set(date, value);
    this.values.set(key, values);
  }
  private conflict(key: SupportedTypeKey, date: string): void {
    const dates = this.conflicts.get(key) ?? new Set<string>(); dates.add(date); this.conflicts.set(key, dates);
  }
  private localDate(timestamp: number, offset: string): string {
    const match = /^UTC([+-])(\d{2})(\d{2})$/.exec(offset);
    if (match && Number(match[2]) <= 14 && Number(match[3]) < 60) {
      const minutes = (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '+' ? 1 : -1);
      return new Date(timestamp + minutes * 60000).toISOString().slice(0, 10);
    }
    const date = dateInTimeZone(timestamp, this.options.timeZone ?? 'UTC');
    if (this.inRange(date)) this.timezoneFallback = true;
    return date;
  }

  private add(dataset: Dataset, r: Row): void {
    if (dataset === 'com.samsung.shealth.step_daily_trend') {
      if (!this.selected('stepCount') || r.source_type !== '-2') return;
      const date = dayLabel(r.day_time);
      if (!this.inRange(date)) return;
      const value = numeric(r.count);
      if (value === undefined || value < 0 || !Number.isInteger(value)) { this.invalidRecords++; return; }
      const updated = utcInstant(r.update_time);
      const records = this.steps.get(date) ?? new Map(); records.set(`${value}/${updated}`, { value, updated }); this.steps.set(date, records); this.recordsMatched++;
      return;
    }
    if (dataset === 'com.samsung.shealth.vitality_score') {
      const date = dayLabel(r.day_time);
      if (!this.selected('heartRateVariability') || !this.inRange(date) || !r.shrv_value.trim()) return;
      const value = numeric(r.shrv_value);
      if (value === undefined || value <= 0) this.invalidRecords++;
      else { this.put('heartRateVariability', date, value); this.recordsMatched++; }
      return;
    }
    if ((dataset === 'com.samsung.shealth.sleep' || dataset === 'com.samsung.health.sleep_stage') && !this.selected('sleepAnalysis')) return;
    if (dataset === 'com.samsung.health.hrv' && !this.selected('heartRateVariability')) return;
    if (dataset === 'com.samsung.health.skin_temperature' && !this.selected('wristTemperature') && !this.selected('temperatureDeviation')) return;
    const start = utcInstant(r.start_time), end = utcInstant(r.end_time);
    if (start === undefined || end === undefined || end < start) { this.invalidRecords++; return; }
    if (dataset === 'com.samsung.health.sleep_stage') {
      if (!this.selected('sleepAnalysis')) return;
      // Bound retained stages while allowing nights that start before the first
      // selected day and timezone offsets near the date boundary.
      const first = Date.parse(`${this.options.startDate}T00:00:00Z`) - 2 * 86400000;
      const last = Date.parse(`${this.options.endDate}T00:00:00Z`) + 2 * 86400000;
      if (end < first || start >= last) return;
      if (!['40001', '40002', '40003', '40004'].includes(r.stage) || !r.sleep_id || end <= start) { this.invalidRecords++; return; }
      this.stages.push({ start, end, parent: r.sleep_id, asleep: r.stage !== '40001' }); this.recordsMatched++;
      return;
    }
    const date = this.localDate(end, r.time_offset ?? '');
    if (!this.inRange(date)) return;
    if (dataset === 'com.samsung.health.hrv') {
      if (this.selected('heartRateVariability') && r.binning_data.trim()) this.rawHrvReferences++;
    } else if (dataset === 'com.samsung.shealth.sleep' && this.selected('sleepAnalysis')) {
      if (!r.datauuid || end <= start) { this.invalidRecords++; return; }
      const prior = this.parents.get(r.datauuid);
      if (prior && (prior.start !== start || prior.end !== end || prior.date !== date)) { this.conflict('sleepAnalysis', prior.date); this.conflict('sleepAnalysis', date); }
      else this.parents.set(r.datauuid, { start, end, date });
    } else if (dataset === 'com.samsung.health.skin_temperature' && (this.selected('wristTemperature') || this.selected('temperatureDeviation'))) {
      const value = numeric(r.temperature);
      if (value === undefined || end <= start) { this.invalidRecords++; return; }
      const baseline = numeric(r.baseline);
      const sessions = this.temperatures.get(date) ?? new Map<string, Temperature>();
      const id = `${start}/${end}`; const prior = sessions.get(id);
      if (prior && (prior.value !== value || prior.baseline !== baseline) || !prior && [...sessions.values()].some(s => start < s.end && end > s.start)) {
        this.conflict('wristTemperature', date); this.conflict('temperatureDeviation', date);
      } else sessions.set(id, { start, end, value, baseline });
      this.temperatures.set(date, sessions); this.recordsMatched++;
    }
  }

  private finishSteps(): void {
    let revised = 0;
    for (const [date, records] of this.steps) {
      const values = [...records.values()];
      if (new Set(values.map(r => r.value)).size === 1) this.put('stepCount', date, values[0].value);
      else if (values.every(r => r.updated !== undefined)) {
        const newest = Math.max(...values.map(r => r.updated!));
        const latest = values.filter(r => r.updated === newest);
        if (new Set(latest.map(r => r.value)).size === 1) { this.put('stepCount', date, latest[0].value); revised++; }
        else this.conflict('stepCount', date);
      } else this.conflict('stepCount', date);
    }
    if (revised) this.warnings.push({ code: 'samsung_revised_steps', detail: String(revised) });
  }

  private finishSleep(): void {
    const days = new Map<string, Stage[]>(); const matched = new Set<string>();
    for (const stage of this.stages) {
      const parent = this.parents.get(stage.parent); if (!parent) continue;
      matched.add(stage.parent);
      if (stage.start < parent.start || stage.end > parent.end) { this.conflict('sleepAnalysis', parent.date); continue; }
      const intervals = days.get(parent.date) ?? []; intervals.push(stage); days.set(parent.date, intervals);
    }
    const missing = new Set([...this.parents].filter(([id]) => !matched.has(id)).map(([, p]) => p.date));
    if (missing.size) this.warnings.push({ code: 'samsung_sleep_stages_missing', detail: String(missing.size) });
    for (const [date, stages] of days) {
      const awake = stages.filter(s => !s.asleep);
      const asleep = stages.filter(s => s.asleep).sort((a, b) => a.start - b.start || a.end - b.end);
      if (asleep.some(s => awake.some(a => s.start < a.end && s.end > a.start))) { this.conflict('sleepAnalysis', date); continue; }
      let total = 0, end = -Infinity;
      for (const s of asleep) { total += Math.max(0, s.end - Math.max(s.start, end)); end = Math.max(end, s.end); }
      this.put('sleepAnalysis', date, total / 60000);
    }
  }

  private finishTemperature(): void {
    let missingBaseline = 0;
    for (const [date, sessions] of this.temperatures) {
      const values = [...sessions.values()]; if (!values.length) continue;
      if (this.selected('wristTemperature')) this.put('wristTemperature', date, values.reduce((sum, s) => sum + s.value, 0) / values.length);
      if (this.selected('temperatureDeviation')) {
        if (values.every(s => s.baseline !== undefined)) this.put('temperatureDeviation', date, values.reduce((sum, s) => sum + s.value - s.baseline!, 0) / values.length);
        else missingBaseline++;
      }
    }
    if (missingBaseline) this.warnings.push({ code: 'missing_baseline', detail: String(missingBaseline) });
  }
}

function numeric(value: string | undefined): number | undefined {
  if (!value?.trim()) return;
  const number = Number(value); return Number.isFinite(number) ? number : undefined;
}
function dayLabel(value: string | undefined): string | undefined {
  const date = value?.slice(0, 10); if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date ? date : undefined;
}
function utcInstant(value: string | undefined): number | undefined {
  if (!value || !dayLabel(value) || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)) return;
  const iso = value.replace(' ', 'T'); const timestamp = Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(iso) ? iso : `${iso}Z`);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}
