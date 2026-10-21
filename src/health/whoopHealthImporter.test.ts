import { describe, expect, it } from 'vitest';
import { WhoopHealthImporter } from './whoopHealthImporter';
import { MEASUREMENT_TYPES } from './measurementTypes';
import type { ProcessingOptions } from './models';

const options: ProcessingOptions = { selectedTypes: Object.keys(MEASUREMENT_TYPES) as ProcessingOptions['selectedTypes'], startDate: '2026-08-24', endDate: '2026-09-20', timeZone: 'America/Los_Angeles' };
const cycle = { 'Cycle start time': '2026-09-19 22:00:00', 'Cycle end time': '', 'Cycle timezone': 'UTC+02:00', 'Sleep onset': '2026-09-19 22:00:00', 'Wake onset': '2026-09-20 00:30:00', 'Resting heart rate (bpm)': '55', 'Heart rate variability (ms)': '60', 'Skin temp (celsius)': '33.25', 'Asleep duration (min)': '120' };
const sleep = { 'Cycle start time': cycle['Cycle start time'], 'Cycle timezone': cycle['Cycle timezone'], 'Sleep onset': cycle['Sleep onset'], 'Wake onset': cycle['Wake onset'], 'Asleep duration (min)': '120', 'Nap': 'false' };
function feed(importer: WhoopHealthImporter, name: string, records: Record<string, string>[]): void {
  const headers = Object.keys(records[0]);
  const quote = (v: string) => `"${v.replaceAll('"', '""')}"`;
  const csv = '\uFEFF' + [headers, ...records.map(r => headers.map(h => r[h] ?? ''))].map(row => row.map(quote).join(',')).join('\r\n');
  const bytes = new TextEncoder().encode(csv);
  const consumer = importer.consumerForEntry('wrapper/' + name)!;
  expect(consumer).toBeDefined();
  for (let i = 0; i < bytes.length; i += 7) consumer(bytes.slice(i, i + 7), i + 7 >= bytes.length);
}
const get = (rows: ReturnType<WhoopHealthImporter['finish']>, category: string, date = '2026-09-20') => rows.find(r => r.category === category && r.date === date)!;

describe('WHOOP summary import', () => {
  it('maps recovery and absolute skin temperature to the exported wake date, including an ongoing cycle', () => {
    const importer = new WhoopHealthImporter(options);
    feed(importer, 'physiological_cycles.csv', [cycle]);
    feed(importer, 'sleeps.csv', [sleep]);
    const rows = importer.finish();
    expect(rows).toHaveLength(168);
    expect(get(rows, 'Sleep duration').value).toBe('120');
    expect(get(rows, 'Resting heart rate').value).toBe('55');
    expect(get(rows, 'HRV')).toMatchObject({ value: '60', unit: 'ms', measurementType: expect.stringContaining('rmssd') });
    expect(get(rows, 'Nightly temperature')).toMatchObject({ value: '33.25', unit: '°C' });
    expect(get(rows, 'Steps').value).toBe('');
    expect(get(rows, 'Temperature deviation').value).toBe('');
    expect(get(rows, 'HRV', '2026-09-19').value).toBe('');
    expect(importer.warnings).toEqual([{ code: 'whoop_no_steps' }, { code: 'whoop_no_baseline' }]);
  });

  it('uses sleeps.csv regardless of file order and counts distinct naps and duplicate sessions once', () => {
    for (const cyclesFirst of [true, false]) {
      const importer = new WhoopHealthImporter(options);
      const nap = { ...sleep, 'Sleep onset': '2026-09-20 14:00:00', 'Wake onset': '2026-09-20 14:30:00', 'Asleep duration (min)': '20', Nap: 'true' };
      const cycles = () => feed(importer, 'physiological_cycles.csv', [{ ...cycle, 'Asleep duration (min)': '125' }, { ...cycle, 'Asleep duration (min)': '126' }]);
      const sleeps = () => feed(importer, 'sleeps.csv', [sleep, sleep, nap, nap]);
      if (cyclesFirst) { cycles(); sleeps(); } else { sleeps(); cycles(); }
      const rows = importer.finish();
      expect(get(rows, 'Sleep duration')).toMatchObject({ value: '140', source: 'WHOOP: sleeps' });
      expect(importer.warnings.some(w => w.code === 'conflicting_sleep')).toBe(false);
    }
  });

  it('uses cycle main sleep only when sleeps.csv is absent, with explicit provenance and warning', () => {
    const importer = new WhoopHealthImporter({ ...options, selectedTypes: ['sleepAnalysis'] });
    feed(importer, 'physiological_cycles.csv', [cycle, cycle]);
    expect(get(importer.finish(), 'Sleep duration')).toMatchObject({ value: '120', source: 'WHOOP: physiological_cycles', measurementType: expect.stringContaining('naps_unavailable') });
    expect(importer.warnings).toEqual([{ code: 'whoop_sleep_fallback' }]);
  });

  it('blanks conflicting daily values and inconsistent or overlapping sleep sessions', () => {
    for (const other of [{ ...sleep, 'Asleep duration (min)': '119' }, { ...sleep, 'Sleep onset': '2026-09-19 23:00:00', 'Asleep duration (min)': '70' }]) {
      const importer = new WhoopHealthImporter(options);
      feed(importer, 'physiological_cycles.csv', [cycle, { ...cycle, 'Resting heart rate (bpm)': '56' }]);
      feed(importer, 'sleeps.csv', [sleep, other]);
      const rows = importer.finish();
      expect(get(rows, 'Resting heart rate').value).toBe('');
      expect(get(rows, 'Sleep duration').value).toBe('');
      expect(get(rows, 'HRV').value).toBe('60');
      expect(importer.warnings).toContainEqual({ code: 'conflicting_values', detail: 'Resting heart rate: 1' });
      expect(importer.warnings).toContainEqual({ code: 'conflicting_sleep', detail: 'Sleep duration: 1' });
    }
  });

  it('preserves zero asleep minutes and missing recovery fields without inventing zeroes', () => {
    const importer = new WhoopHealthImporter(options);
    feed(importer, 'physiological_cycles.csv', [{ ...cycle, 'Resting heart rate (bpm)': '', 'Heart rate variability (ms)': '', 'Skin temp (celsius)': '' }]);
    feed(importer, 'sleeps.csv', [{ ...sleep, 'Asleep duration (min)': '0' }]);
    const rows = importer.finish();
    expect(get(rows, 'Sleep duration').value).toBe('0');
    expect(get(rows, 'HRV').value).toBe('');
    expect(get(rows, 'Resting heart rate').value).toBe('');
    expect(get(rows, 'Nightly temperature').value).toBe('');
    expect(importer.warnings.some(w => w.code === 'invalid_records')).toBe(false);
  });

  it('excludes invalid numeric values and intervals, without substituting in-bed duration or stage totals', () => {
    const importer = new WhoopHealthImporter(options);
    feed(importer, 'physiological_cycles.csv', [{ ...cycle, 'Resting heart rate (bpm)': 'Infinity', 'Heart rate variability (ms)': '0', 'Skin temp (celsius)': '33,25' }]);
    feed(importer, 'sleeps.csv', [{ ...sleep, 'Sleep onset': '2026-09-20 01:00:00' }, { ...sleep, 'Asleep duration (min)': '', 'In bed duration (min)': '150' }]);
    const rows = importer.finish();
    expect(rows.every(r => r.value === '')).toBe(true);
    expect(importer.warnings).toContainEqual({ code: 'invalid_records', detail: '4' });
  });

  it('keeps date-window boundaries, skips invalid dates, and processes selected metrics only', () => {
    const importer = new WhoopHealthImporter({ ...options, selectedTypes: ['restingHeartRate'] });
    feed(importer, 'physiological_cycles.csv', [cycle,
      { ...cycle, 'Wake onset': '2026-08-24 00:05:00', 'Resting heart rate (bpm)': '51' },
      { ...cycle, 'Wake onset': '2026-09-21 00:05:00' },
      { ...cycle, 'Wake onset': '2026-02-30 00:05:00' }
    ]);
    const rows = importer.finish();
    expect(rows).toHaveLength(28);
    expect(get(rows, 'Resting heart rate', '2026-08-24').value).toBe('51');
    expect(get(rows, 'Resting heart rate').value).toBe('55');
    expect(importer.warnings).toEqual([]);
  });

  it('accepts older cycles without temperature and ignores personal files and resource forks', () => {
    const importer = new WhoopHealthImporter(options);
    const { 'Skin temp (celsius)': omitted, ...older } = cycle;
    feed(importer, 'PHYSIOLOGICAL_CYCLES.CSV', [older]);
    for (const name of ['journal_entries.csv', 'workouts.csv', '__MACOSX/physiological_cycles.csv', '._sleeps.csv']) expect(importer.consumerForEntry(name)).toBeUndefined();
    expect(get(importer.finish(), 'Nightly temperature').value).toBe('');
    const invalid = new WhoopHealthImporter(options).consumerForEntry('sleeps.csv')!;
    expect(() => invalid(new TextEncoder().encode('unknown,columns\n'), true)).toThrow('missing expected columns');
  });
});
