import { getCalendarDates } from './dateRange';
import { SUMMARY_TYPE_ORDER, type SupportedTypeKey } from './measurementTypes';
import { csvObjectConsumer } from './streamingParsers';
import type { CsvSummaryRow } from './csv';
import type { ImportWarning, ProcessingOptions } from './models';

type Row = Record<string, string>;
type Session = { start: number; end: number; minutes: number };
const definitions: Record<SupportedTypeKey, { category: string; unit: string; source: string; measurementType: string }> = {
  sleepAnalysis: { category: 'Sleep duration', unit: 'min', source: 'WHOOP: sleeps', measurementType: 'sleep_duration;provided_asleep_minutes;including_nonoverlapping_naps;exported_wake_date' },
  stepCount: { category: 'Steps', unit: 'steps', source: 'WHOOP', measurementType: 'step_count;not_available_in_supported_csv' },
  heartRateVariability: { category: 'HRV', unit: 'ms', source: 'WHOOP: physiological_cycles', measurementType: 'heart_rate_variability_rmssd;provided_recovery_summary;exported_wake_date' },
  restingHeartRate: { category: 'Resting heart rate', unit: 'bpm', source: 'WHOOP: physiological_cycles', measurementType: 'resting_heart_rate;provided_recovery_summary;exported_wake_date' },
  wristTemperature: { category: 'Nightly temperature', unit: '°C', source: 'WHOOP: physiological_cycles', measurementType: 'nightly_skin_temperature;provided_recovery_summary;exported_wake_date' },
  temperatureDeviation: { category: 'Temperature deviation', unit: '°C', source: 'WHOOP', measurementType: 'nightly_skin_temperature_deviation;baseline_not_available' }
};

export class WhoopHealthImporter {
  readonly warnings: ImportWarning[] = [];
  recognizedEntries = 0;
  recordsMatched = 0;
  private values = new Map<SupportedTypeKey, Map<string, number>>();
  private conflicts = new Map<SupportedTypeKey, Set<string>>();
  private sleeps = new Map<string, Map<string, Session>>();
  private cycleSleeps = new Map<string, Map<string, Session>>();
  private sleepConflicts = new Set<string>();
  private cycleSleepConflicts = new Set<string>();
  private hasSleepsFile = false;
  private invalidRecords = 0;

  constructor(private readonly options: ProcessingOptions) {}

  /** Only the two summary datasets are read; journals and workouts stay untouched. */
  consumerForEntry(path: string): ((bytes: Uint8Array, final: boolean) => void) | undefined {
    const parts = path.replaceAll('\\', '/').toLowerCase().split('/');
    if (parts.includes('__macosx') || parts.at(-1)?.startsWith('._')) return;
    const name = parts.at(-1);
    if (name !== 'physiological_cycles.csv' && name !== 'sleeps.csv') return;
    const isSleeps = name === 'sleeps.csv';
    if (isSleeps) this.hasSleepsFile = true;
    this.recognizedEntries++;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const parser = csvObjectConsumer(['Cycle start time', 'Cycle timezone', 'Sleep onset', 'Wake onset', ...(isSleeps ? ['Asleep duration (min)', 'Nap'] : ['Resting heart rate (bpm)', 'Heart rate variability (ms)'])], r => {
      if (isSleeps) this.addSleep(r, false);
      else { this.addRecovery(r); this.addSleep(r, true); }
    });
    return (bytes, final) => {
      parser.push(decoder.decode(bytes, { stream: !final }));
      if (final) parser.finish();
    };
  }

  finish(): CsvSummaryRow[] {
    const rows: CsvSummaryRow[] = [];
    for (const key of SUMMARY_TYPE_ORDER) {
      if (!this.selected(key)) continue;
      const sleepData = this.hasSleepsFile ? this.sleeps : this.cycleSleeps;
      const conflicts = key === 'sleepAnalysis' ? (this.hasSleepsFile ? this.sleepConflicts : this.cycleSleepConflicts) : this.conflicts.get(key);
      if (conflicts?.size) this.warnings.push({ code: key === 'sleepAnalysis' ? 'conflicting_sleep' : 'conflicting_values', detail: `${definitions[key].category}: ${conflicts.size}` });
      let available = false;
      for (const date of getCalendarDates(this.options.startDate!, this.options.endDate!)) {
        let value: number | undefined;
        if (!conflicts?.has(date)) {
          const sessions = sleepData.get(date);
          value = key === 'sleepAnalysis' ? (sessions?.size ? [...sessions.values()].reduce((sum, s) => sum + s.minutes, 0) : undefined) : this.values.get(key)?.get(date);
        }
        if (value !== undefined) available = true;
        const definition = key === 'sleepAnalysis' && !this.hasSleepsFile ? {
          ...definitions[key], source: 'WHOOP: physiological_cycles', measurementType: 'sleep_duration;provided_main_sleep_minutes;naps_unavailable;exported_wake_date'
        } : definitions[key];
        rows.push({ ...definition, date, value: value === undefined ? '' : String(value) });
      }
      if (key === 'stepCount') this.warnings.push({ code: 'whoop_no_steps' });
      else if (key === 'temperatureDeviation') this.warnings.push({ code: 'whoop_no_baseline' });
      else if (!available) this.warnings.push({ code: 'missing_metric', detail: definitions[key].category });
      if (key === 'sleepAnalysis' && !this.hasSleepsFile && available) this.warnings.push({ code: 'whoop_sleep_fallback' });
    }
    if (this.invalidRecords) this.warnings.push({ code: 'invalid_records', detail: String(this.invalidRecords) });
    if (!rows.some(r => r.value !== '')) this.warnings.push({ code: 'no_measurements' });
    return rows;
  }

  private selected(key: SupportedTypeKey): boolean { return this.options.selectedTypes.includes(key); }
  private date(r: Row): string | undefined {
    // CSV timestamps have no offset. Preserve the exported wake calendar date,
    // rather than treating local clocks as UTC or applying the browser timezone.
    if (wallTime(r['Wake onset']) === undefined) return;
    const date = r['Wake onset'].slice(0, 10);
    return date >= this.options.startDate! && date <= this.options.endDate! ? date : undefined;
  }

  private addRecovery(r: Row): void {
    const date = this.date(r);
    if (!date) return;
    for (const [key, field] of [
      ['restingHeartRate', 'Resting heart rate (bpm)'],
      ['heartRateVariability', 'Heart rate variability (ms)'],
      ['wristTemperature', 'Skin temp (celsius)']
    ] as const) {
      if (!this.selected(key) || !r[field]?.trim()) continue;
      const value = numeric(r[field]);
      if (value === undefined || value <= 0) { this.invalidRecords++; continue; }
      const values = this.values.get(key) ?? new Map<string, number>();
      const existing = values.get(date);
      if (existing !== undefined && existing !== value) {
        const conflicts = this.conflicts.get(key) ?? new Set<string>();
        conflicts.add(date); this.conflicts.set(key, conflicts);
      } else values.set(date, value);
      this.values.set(key, values); this.recordsMatched++;
    }
  }

  private addSleep(r: Row, cycle: boolean): void {
    if (!this.selected('sleepAnalysis')) return;
    const date = this.date(r);
    if (!date || !r['Asleep duration (min)']?.trim()) return;
    const start = wallTime(r['Sleep onset']);
    const end = wallTime(r['Wake onset']);
    const minutes = numeric(r['Asleep duration (min)']);
    if (start === undefined || end === undefined || end <= start || minutes === undefined || minutes < 0 || (!cycle && !/^(?:true|false)$/i.test(r.Nap))) {
      this.invalidRecords++; return;
    }
    const data = cycle ? this.cycleSleeps : this.sleeps;
    const conflicts = cycle ? this.cycleSleepConflicts : this.sleepConflicts;
    const sessions = data.get(date) ?? new Map<string, Session>();
    const id = `${start}/${end}`;
    const same = sessions.get(id);
    if (same) {
      if (same.minutes !== minutes) conflicts.add(date);
    } else {
      if ([...sessions.values()].some(s => start < s.end && end > s.start)) conflicts.add(date);
      sessions.set(id, { start, end, minutes });
    }
    data.set(date, sessions); this.recordsMatched++;
  }
}

function numeric(value: string): number | undefined {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) return;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/** Validate a printed local timestamp without assigning a timezone to it. */
function wallTime(value: string | undefined): number | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return;
  const iso = value.replace(' ', 'T') + 'Z';
  const time = Date.parse(iso);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === iso.slice(0, 19) ? time : undefined;
}
