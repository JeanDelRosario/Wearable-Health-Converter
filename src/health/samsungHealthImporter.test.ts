import { describe, expect, it } from 'vitest';
import { SamsungHealthImporter } from './samsungHealthImporter';
import { MEASUREMENT_TYPES } from './measurementTypes';
import type { ProcessingOptions } from './models';

const options: ProcessingOptions = { selectedTypes: Object.keys(MEASUREMENT_TYPES) as ProcessingOptions['selectedTypes'], startDate: '2026-08-24', endDate: '2026-09-20', timeZone: 'Europe/Amsterdam' };
const step = 'com.samsung.shealth.step_daily_trend';
const sleep = 'com.samsung.shealth.sleep';
const stage = 'com.samsung.health.sleep_stage';
const temperature = 'com.samsung.health.skin_temperature';
const score = 'com.samsung.shealth.vitality_score';
const hrv = 'com.samsung.health.hrv';
const columns: Record<string, string[]> = {
  [step]: ['day_time', 'source_type', 'count', 'update_time'],
  [sleep]: ['com.samsung.health.sleep.start_time', 'com.samsung.health.sleep.end_time', 'com.samsung.health.sleep.datauuid', 'com.samsung.health.sleep.time_offset'],
  [stage]: ['start_time', 'end_time', 'sleep_id', 'stage', 'time_offset'],
  [temperature]: ['start_time', 'end_time', 'temperature', 'baseline', 'time_offset'],
  [score]: ['day_time', 'shrv_value', 'shr_value'],
  [hrv]: ['start_time', 'end_time', 'binning_data', 'time_offset']
};
function feed(importer: SamsungHealthImporter, dataset: string, rows: string[][]): void {
  const csv = '\uFEFF' + [dataset + ',7006011,4', columns[dataset].join(','), ...rows.map(r => r.map(v => `"${v.replaceAll('"', '""')}"`).join(',') + ',')].join('\r\n');
  const consumer = importer.consumerForEntry(`wrapper/${dataset}.20261011202615.csv`)!;
  expect(consumer).toBeDefined();
  const bytes = new TextEncoder().encode(csv);
  for (let offset = 0; offset < bytes.length; offset += 7) consumer(bytes.slice(offset, offset + 7), offset + 7 >= bytes.length);
}
const get = (rows: ReturnType<SamsungHealthImporter['finish']>, category: string, date = '2026-09-20') => rows.find(r => r.category === category && r.date === date)!;

describe('Samsung CSV import', () => {
  it('parses metadata, prefixed headers, trailing commas and uses only combined step totals', () => {
    const importer = new SamsungHealthImporter(options);
    feed(importer, step, [
      ['2026-09-20 00:00:00.000', '-2', '0', '2026-09-20 18:00:00.000'],
      ['2026-09-20 00:00:00.000', '0', '100', '2026-09-20 18:00:00.000'],
      ['2026-09-20 00:00:00.000', '13', '200', '2026-09-20 18:00:00.000']
    ]);
    const rows = importer.finish();
    expect(rows).toHaveLength(168);
    expect(get(rows, 'Steps')).toMatchObject({ value: '0', unit: 'steps', source: 'Samsung Health: step_daily_trend' });
    expect(get(rows, 'Steps', '2026-09-19').value).toBe('');
  });

  it('resolves step revisions by update time independent of row order, without summing duplicates', () => {
    const rows = [
      ['2026-09-20 00:00:00.000', '-2', '200', '2026-09-21 18:00:00.000'],
      ['2026-09-20 00:00:00.000', '-2', '100', '2026-09-20 18:00:00.000'],
      ['2026-09-20 00:00:00.000', '-2', '200', '2026-09-21 18:00:00.000']
    ];
    for (const data of [rows, [...rows].reverse()]) {
      const importer = new SamsungHealthImporter({ ...options, selectedTypes: ['stepCount'] });
      feed(importer, step, data);
      expect(get(importer.finish(), 'Steps').value).toBe('200');
      expect(importer.warnings).toEqual([{ code: 'samsung_revised_steps', detail: '1' }]);
    }
  });

  it('blanks conflicting step revisions with the same timestamp', () => {
    const importer = new SamsungHealthImporter({ ...options, selectedTypes: ['stepCount'] });
    feed(importer, step, [['2026-09-20', '-2', '100', '2026-09-20 18:00:00.000'], ['2026-09-20', '-2', '200', '2026-09-20 18:00:00.000']]);
    expect(get(importer.finish(), 'Steps').value).toBe('');
    expect(importer.warnings).toContainEqual({ code: 'conflicting_values', detail: 'Steps: 1' });
  });

  it('joins stages to parent nights regardless of archive order and unions asleep intervals once', () => {
    const importer = new SamsungHealthImporter({ ...options, selectedTypes: ['sleepAnalysis'] });
    feed(importer, stage, [
      ['2026-09-19 21:00:00.000', '2026-09-19 22:00:00.000', 'synthetic', '40002', 'UTC+0200'],
      ['2026-09-19 21:30:00.000', '2026-09-19 22:00:00.000', 'synthetic', '40003', 'UTC+0200'],
      ['2026-09-19 22:00:00.000', '2026-09-19 22:30:00.000', 'synthetic', '40001', 'UTC+0200'],
      ['2026-09-19 22:30:00.000', '2026-09-19 23:00:00.000', 'synthetic', '40004', 'UTC+0200']
    ]);
    feed(importer, sleep, [['2026-09-19 21:00:00.000', '2026-09-19 23:00:00.000', 'synthetic', 'UTC+0200']]);
    const rows = importer.finish();
    expect(get(rows, 'Sleep duration').value).toBe('90');
    expect(get(rows, 'Sleep duration', '2026-09-19').value).toBe('');
    expect(importer.warnings).toEqual([]);
  });

  it('excludes unstaged sleep rather than substituting time in bed, and flags awake/asleep conflicts', () => {
    const importer = new SamsungHealthImporter({ ...options, selectedTypes: ['sleepAnalysis'] });
    feed(importer, sleep, [['2026-09-19 21:00:00.000', '2026-09-20 05:00:00.000', 'unstaged', 'UTC+0200']]);
    expect(get(importer.finish(), 'Sleep duration').value).toBe('');
    expect(importer.warnings).toContainEqual({ code: 'samsung_sleep_stages_missing', detail: '1' });
    const conflict = new SamsungHealthImporter({ ...options, selectedTypes: ['sleepAnalysis'] });
    feed(conflict, sleep, [['2026-09-19 21:00:00.000', '2026-09-20 05:00:00.000', 'synthetic', 'UTC+0200']]);
    feed(conflict, stage, [
      ['2026-09-20 01:00:00.000', '2026-09-20 02:00:00.000', 'synthetic', '40001', 'UTC+0200'],
      ['2026-09-20 01:00:00.000', '2026-09-20 02:00:00.000', 'synthetic', '40002', 'UTC+0200']
    ]);
    expect(get(conflict.finish(), 'Sleep duration').value).toBe('');
    expect(conflict.warnings).toContainEqual({ code: 'conflicting_sleep', detail: 'Sleep duration: 1' });
  });

  it('exports temperature session means and paired baselines, preserving a zero deviation', () => {
    const importer = new SamsungHealthImporter({ ...options, selectedTypes: ['wristTemperature', 'temperatureDeviation'] });
    const a = ['2026-09-19 20:00:00.000', '2026-09-19 22:30:00.000', '34', '34', 'UTC+0200'];
    feed(importer, temperature, [a, a, ['2026-09-19 23:00:00.000', '2026-09-20 04:00:00.000', '36', '36', 'UTC+0200']]);
    const rows = importer.finish();
    expect(get(rows, 'Nightly temperature')).toMatchObject({ value: '35.00', unit: '°C' });
    expect(get(rows, 'Temperature deviation').value).toBe('0.00');
    expect(importer.warnings).toEqual([]);
  });

  it('leaves the whole daily deviation blank when a temperature session has no baseline', () => {
    const importer = new SamsungHealthImporter({ ...options, selectedTypes: ['wristTemperature', 'temperatureDeviation'] });
    feed(importer, temperature, [
      ['2026-09-20 00:00:00.000', '2026-09-20 01:00:00.000', '34', '', 'UTC+0200'],
      ['2026-09-20 01:00:00.000', '2026-09-20 02:00:00.000', '36', '35', 'UTC+0200']
    ]);
    const rows = importer.finish();
    expect(get(rows, 'Nightly temperature').value).toBe('35.00');
    expect(get(rows, 'Temperature deviation').value).toBe('');
    expect(importer.warnings).toContainEqual({ code: 'missing_baseline', detail: '1' });
  });

  it('uses exported sleeping HRV, never sleeping HR as resting HR, and reports raw-only references', () => {
    const importer = new SamsungHealthImporter(options);
    feed(importer, score, [['2026-09-20 00:00:00.000', '42.5', '65']]);
    feed(importer, hrv, [['2026-09-20 00:00:00.000', '2026-09-20 01:00:00.000', 'synthetic.binning_data.json', 'UTC+0200']]);
    const rows = importer.finish();
    expect(get(rows, 'HRV')).toMatchObject({ value: '42.5', measurementType: expect.stringContaining('method_not_exported') });
    expect(get(rows, 'Resting heart rate').value).toBe('');
    expect(importer.warnings).toContainEqual({ code: 'samsung_hrv_raw_unavailable', detail: '1' });
  });

  it('uses the selected zone only when the exported time offset is unavailable', () => {
    const importer = new SamsungHealthImporter({ ...options, selectedTypes: ['wristTemperature'], timeZone: 'America/New_York' });
    feed(importer, temperature, [['2026-09-20 01:00:00.000', '2026-09-20 02:00:00.000', '34', '', '']]);
    expect(get(importer.finish(), 'Nightly temperature', '2026-09-19').value).toBe('34.00');
    expect(importer.warnings).toContainEqual({ code: 'samsung_timezone_fallback' });
  });

  it('ignores resource forks and unrelated files and rejects malformed CSV', () => {
    const importer = new SamsungHealthImporter(options);
    expect(importer.consumerForEntry(`__MACOSX/._${step}.20261011202615.csv`)).toBeUndefined();
    expect(importer.consumerForEntry('com.samsung.health.user_profile.20261011202615.csv')).toBeUndefined();
    expect(importer.consumerForEntry('com.samsung.shealth.tracker.heart_rate.20261011202615.csv')).toBeUndefined();
    const consumer = importer.consumerForEntry(step + '.csv')!;
    expect(() => consumer(new TextEncoder().encode('wrong,header\n'), true)).toThrow('missing expected columns');
  });
});
