import { describe, expect, it } from 'vitest';
import { GoogleHealthImporter } from './googleHealthImporter';
import type { ProcessingOptions } from './models';
import { MEASUREMENT_TYPES } from './measurementTypes';

const options: ProcessingOptions = { selectedTypes: Object.keys(MEASUREMENT_TYPES) as ProcessingOptions['selectedTypes'], startDate: '2026-08-24', endDate: '2026-09-20', timeZone: 'Europe/Amsterdam' };
const base = 'Takeout/Google Health/Physical Activity_GoogleData/';
function add(importer: GoogleHealthImporter, name: string, text: string, chunkSize = 7): void {
  const consumer = importer.consumerForEntry(name);
  expect(consumer).toBeDefined();
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i += chunkSize) consumer!(bytes.slice(i, i + chunkSize), i + chunkSize >= bytes.length);
}
const value = (rows: ReturnType<GoogleHealthImporter['finish']>, category: string, date = '2026-09-20') => rows.find((r) => r.category === category && r.date === date)!;
const sleep = { logId: 1, dateOfSleep: '2026-09-20', startTime: '2026-09-19T23:00:00', endTime: '2026-09-20T07:00:00', minutesAsleep: 420 };

describe('Google/Fitbit importer', () => {
  it('exports daily summaries with provenance and keeps missing dates blank', () => {
    const importer = new GoogleHealthImporter(options);
    add(importer, base + 'daily_resting_heart_rate.csv', 'timestamp,beats per minute,data source\r\n2026-09-20T00:00:00Z,60.25,"Watch, α"\r\n', 1);
    add(importer, base + 'daily_heart_rate_variability.csv', 'timestamp,average heart rate variability milliseconds\n2026-09-20T00:00:00Z,42.5\n');
    add(importer, base + 'daily_sleep_temperature_derivations.csv', 'timestamp,nightly temperature celsius,baseline temperature celsius\n2026-09-20T00:00:00Z,32.5,32\n2026-09-19T00:00:00Z,32,NaN\n');
    const rows = importer.finish();
    expect(rows).toHaveLength(168);
    expect(value(rows, 'Resting heart rate')).toMatchObject({ value: '60.25', source: expect.stringContaining('daily_resting_heart_rate.csv') });
    expect(value(rows, 'HRV')).toMatchObject({ value: '42.5', measurementType: expect.stringContaining('rmssd') });
    expect(value(rows, 'Nightly temperature').value).toBe('32.5');
    expect(value(rows, 'Temperature deviation').value).toBe('0.5');
    expect(value(rows, 'Temperature deviation', '2026-09-19').value).toBe('');
    expect(value(rows, 'Resting heart rate', '2026-09-19').value).toBe('');
    expect(importer.warnings).toContainEqual({ code: 'missing_baseline', detail: '1' });
  });

  it('groups UTC steps in the selected timezone and never combines legacy and current representations', () => {
    const importer = new GoogleHealthImporter(options);
    add(importer, 'Google Health/Global Export Data/steps-2026-09-02.json', JSON.stringify([{ dateTime: '09/19/26 23:00:00', value: '999' }]));
    add(importer, base + 'steps_2026-09-01.csv', 'timestamp,steps,data source\n2026-09-19T23:00:00Z,20,Watch\n2026-09-19T23:00:00Z,20,Watch\n2026-09-20T06:00:00Z,30,Watch\n');
    const rows = importer.finish();
    expect(value(rows, 'Steps').value).toBe('50');
    expect(value(rows, 'Steps', '2026-09-19').value).toBe('');
    expect(value(rows, 'Steps').measurementType).toContain('Europe/Amsterdam');
  });

  it('deduplicates sleep IDs by relevant values and includes distinct non-overlapping naps', () => {
    const importer = new GoogleHealthImporter(options);
    add(importer, 'Google Health/Global Export Data/sleep-2026-08-03.json', JSON.stringify([sleep]));
    add(importer, 'Google Health/Global Export Data/sleep-2026-09-02.json', JSON.stringify([{ ...sleep, other: 'changed' }, { ...sleep, logId: 2, startTime: '2026-09-20T13:00:00', endTime: '2026-09-20T13:45:00', minutesAsleep: 40 }]));
    expect(value(importer.finish(), 'Sleep duration').value).toBe('460');
    expect(importer.warnings).toContainEqual({ code: 'duplicate_sleep', detail: '1' });
  });

  it('leaves conflicting steps, daily values, and sleep totals blank with warnings', () => {
    const importer = new GoogleHealthImporter(options);
    add(importer, base + 'steps_2026-09-01.csv', 'timestamp,steps,data source\n2026-09-20T06:00:00Z,20,Watch\n2026-09-20T06:00:00Z,30,Phone\n');
    add(importer, base + 'daily_resting_heart_rate.csv', 'timestamp,beats per minute\n2026-09-20T00:00:00Z,60\n2026-09-20T00:00:00Z,70\n');
    add(importer, 'Google Health/Global Export Data/sleep-2026-09-02.json', JSON.stringify([sleep, { ...sleep, minutesAsleep: 400 }]));
    const rows = importer.finish();
    for (const category of ['Steps', 'Resting heart rate', 'Sleep duration']) expect(value(rows, category).value).toBe('');
    expect(importer.warnings.some((w) => w.code === 'conflicting_values')).toBe(true);
    expect(importer.warnings.some((w) => w.code === 'conflicting_sleep')).toBe(true);
  });

  it('prefers current Google summaries for the entire metric and reports discrepancies', () => {
    const importer = new GoogleHealthImporter(options);
    add(importer, 'Google Health/Heart Rate Variability/Daily Heart Rate Variability Summary - 2026-09-20.csv', 'timestamp,rmssd\n2026-09-20T00:00:00,10\n2026-09-19T00:00:00,15\n');
    add(importer, base + 'daily_heart_rate_variability.csv', 'timestamp,average heart rate variability milliseconds\n2026-09-20T00:00:00Z,20\n');
    const rows = importer.finish();
    expect(value(rows, 'HRV').value).toBe('20');
    expect(value(rows, 'HRV', '2026-09-19').value).toBe('');
    expect(importer.warnings).toContainEqual({ code: 'preferred_google', detail: 'hrv: 1' });
  });

  it('supports legacy files without inventing a temperature baseline', () => {
    const importer = new GoogleHealthImporter(options);
    add(importer, 'Google Health/Global Export Data/resting_heart_rate-2026-09-01.json', JSON.stringify([{ dateTime: '09/20/26 00:00:00', value: { value: 60 } }]));
    add(importer, 'Google Health/Temperature/Computed Temperature - 2026-09-01.csv', 'type,sleep_end,nightly_temperature\nIDT,2026-09-20T07:00,32.5\n');
    const rows = importer.finish();
    expect(value(rows, 'Resting heart rate').value).toBe('60');
    expect(value(rows, 'Nightly temperature')).toMatchObject({ value: '32.5', measurementType: expect.stringContaining('_idt') });
    expect(value(rows, 'Temperature deviation').value).toBe('');
  });

  it('ignores unrelated files and rejects unrecognized archives', () => {
    const importer = new GoogleHealthImporter(options);
    expect(importer.consumerForEntry('Google Health/Your Profile/profile.json')).toBeUndefined();
    expect(() => importer.finish()).toThrow('No supported');
  });
});
