import { describe, expect, it } from 'vitest';
import { GarminHealthImporter } from './garminHealthImporter';
import { MEASUREMENT_TYPES } from './measurementTypes';
import type { ProcessingOptions } from './models';

const options: ProcessingOptions = { selectedTypes: Object.keys(MEASUREMENT_TYPES) as ProcessingOptions['selectedTypes'], startDate: '2026-08-24', endDate: '2026-09-20', timeZone: 'Europe/Amsterdam' };
const paths = {
  daily: 'wrapper/DI_CONNECT/DI-Connect-Aggregator/UDSFile_2026-07-01_2026-10-09.json',
  sleep: 'wrapper/DI_CONNECT/DI-Connect-Wellness/2026-07-01_2026-10-09_synthetic_sleepData.json',
  status: 'wrapper/DI_CONNECT/DI-Connect-Wellness/2026-07-01_2026-10-09_synthetic_healthStatusData.json'
};
function feed(importer: GarminHealthImporter, path: string, rows: Record<string, unknown>[]): void {
  const consumer = importer.consumerForEntry(path)!;
  expect(consumer).toBeDefined();
  const bytes = new TextEncoder().encode(JSON.stringify(rows));
  for (let i = 0; i < bytes.length; i += 11) consumer(bytes.slice(i, i + 11), i + 11 >= bytes.length);
}
const sleep = {
  calendarDate: '2026-09-20', sleepWindowConfirmationType: 'ENHANCED_CONFIRMED_FINAL',
  sleepStartTimestampGMT: '2026-09-19T22:00:00.0', sleepEndTimestampGMT: '2026-09-20T06:00:00.0',
  deepSleepSeconds: 3600, lightSleepSeconds: 18000, remSleepSeconds: 3600, awakeSleepSeconds: 1200, unmeasurableSeconds: 2400
};
const get = (rows: ReturnType<GarminHealthImporter['finish']>, category: string, date = '2026-09-20') => rows.find(r => r.category === category && r.date === date)!;

describe('Garmin daily-summary import', () => {
  it('maps daily fields, keeps zeroes, and imports temperature as deviation only', () => {
    const importer = new GarminHealthImporter(options);
    feed(importer, paths.daily, [{ calendarDate: '2026-09-20', totalSteps: 0, currentDayRestingHeartRate: 50, restingHeartRate: 56 }]);
    feed(importer, paths.sleep, [sleep, { retro: false }]);
    feed(importer, paths.status, [{ calendarDate: '2026-09-20', metrics: [
      { type: 'HRV', value: 42, status: 'IN_RANGE' }, { type: 'HR', value: 66 },
      { type: 'SKIN_TEMP_C', value: 0, baselineLowerLimit: -0.8, baselineUpperLimit: 0.7, status: 'IN_RANGE' }
    ] }]);
    const rows = importer.finish();
    expect(rows).toHaveLength(168);
    expect(get(rows, 'Steps').value).toBe('0');
    expect(get(rows, 'Resting heart rate').value).toBe('50');
    expect(get(rows, 'Sleep duration').value).toBe('420');
    expect(get(rows, 'HRV')).toMatchObject({ value: '42', unit: 'ms', measurementType: expect.stringContaining('method_not_exported') });
    expect(get(rows, 'Temperature deviation')).toMatchObject({ value: '0', unit: '°C' });
    expect(get(rows, 'Nightly temperature').value).toBe('');
    expect(get(rows, 'Steps', '2026-09-19').value).toBe('');
    expect(importer.warnings).toEqual([{ code: 'garmin_no_absolute_temperature' }]);
  });

  it('deduplicates daily summaries and sleep intervals, including nonoverlapping naps once', () => {
    const importer = new GarminHealthImporter(options);
    const nap = { calendarDate: '2026-09-20', napStartTimestampGMT: '2026-09-20T12:00:00.0', napEndTimestampGMT: '2026-09-20T12:30:30.0', napTimeSec: 1830 };
    const record = { ...sleep, napList: [nap, nap] };
    feed(importer, paths.sleep, [record, record]);
    const daily = { calendarDate: '2026-09-20', totalSteps: 1234 };
    feed(importer, paths.daily, [daily, daily]);
    const rows = importer.finish();
    expect(get(rows, 'Sleep duration').value).toBe('450.5');
    expect(get(rows, 'Steps').value).toBe('1234');
  });

  it('blanks conflicting duplicate metric values and overlapping sleep records', () => {
    const importer = new GarminHealthImporter(options);
    feed(importer, paths.daily, [{ calendarDate: '2026-09-20', totalSteps: 10 }, { calendarDate: '2026-09-20', totalSteps: 11 }]);
    feed(importer, paths.sleep, [sleep, { ...sleep, sleepStartTimestampGMT: '2026-09-19T23:00:00.0', lightSleepSeconds: 12000 }]);
    const rows = importer.finish();
    expect(get(rows, 'Steps').value).toBe('');
    expect(get(rows, 'Sleep duration').value).toBe('');
    expect(importer.warnings).toContainEqual({ code: 'conflicting_values', detail: 'Steps: 1' });
    expect(importer.warnings).toContainEqual({ code: 'conflicting_sleep', detail: 'Sleep duration: 1' });
  });

  it('handles older non-REM sleep, ignores unconfirmed windows, and never substitutes time in bed', () => {
    const importer = new GarminHealthImporter(options);
    const { remSleepSeconds, ...older } = sleep;
    feed(importer, paths.sleep, [older,
      { ...sleep, calendarDate: '2026-09-19', sleepWindowConfirmationType: 'UNCONFIRMED' },
      { calendarDate: '2026-09-18', sleepStartTimestampGMT: '2026-09-17T22:00:00.0', sleepEndTimestampGMT: '2026-09-18T06:00:00.0' }
    ]);
    const rows = importer.finish();
    expect(get(rows, 'Sleep duration').value).toBe('360');
    expect(get(rows, 'Sleep duration', '2026-09-19').value).toBe('');
    expect(get(rows, 'Sleep duration', '2026-09-18').value).toBe('');
  });

  it('retains exported sleep stages with a warning when an edited window is shorter than the stage total', () => {
    const importer = new GarminHealthImporter({ ...options, selectedTypes: ['sleepAnalysis'] });
    feed(importer, paths.sleep, [{ ...sleep, sleepWindowConfirmationType: 'MANUALLY_CONFIRMED', sleepEndTimestampGMT: '2026-09-20T04:59:00.0' }]);
    expect(get(importer.finish(), 'Sleep duration').value).toBe('420');
    expect(importer.warnings).toContainEqual({ code: 'garmin_sleep_window_mismatch', detail: '1' });
  });

  it('preserves negative deviations and onboarding measurements but excludes unknown placeholders and invalid HRV', () => {
    const importer = new GarminHealthImporter(options);
    feed(importer, paths.status, [
      { calendarDate: '2026-09-20', metrics: [{ type: 'SKIN_TEMP_C', value: -0.3, status: 'ONBOARDING' }, { type: 'HRV', value: 0 }] },
      { calendarDate: '2026-09-19', metrics: [{ type: 'SKIN_TEMP_C', value: 0, status: 'UNKNOWN' }] }
    ]);
    const rows = importer.finish();
    expect(get(rows, 'Temperature deviation').value).toBe('-0.3');
    expect(get(rows, 'Temperature deviation', '2026-09-19').value).toBe('');
    expect(get(rows, 'HRV').value).toBe('');
    expect(importer.warnings).toContainEqual({ code: 'invalid_records', detail: '1' });
  });

  it('uses exported calendar dates and selected metrics without substituting rolling or overnight heart rate', () => {
    const importer = new GarminHealthImporter({ ...options, selectedTypes: ['restingHeartRate'], timeZone: 'America/Los_Angeles' });
    feed(importer, paths.daily, [
      { calendarDate: '2026-08-24', currentDayRestingHeartRate: 61 },
      { calendarDate: '2026-09-20', restingHeartRate: 55 },
      { calendarDate: '2026-09-21', currentDayRestingHeartRate: 60 },
      { calendarDate: '2026-02-30', currentDayRestingHeartRate: 62 }
    ]);
    feed(importer, paths.status, [{ calendarDate: '2026-09-20', metrics: [{ type: 'HR', value: 58 }] }]);
    const rows = importer.finish();
    expect(rows).toHaveLength(28);
    expect(get(rows, 'Resting heart rate', '2026-08-24').value).toBe('61');
    expect(get(rows, 'Resting heart rate').value).toBe('');
    expect(importer.warnings).toEqual([]);
  });

  it('rejects truncated JSON and does not recognize profile, training, or raw workout files', () => {
    const importer = new GarminHealthImporter(options);
    expect(importer.consumerForEntry('customer_data/customer.json')).toBeUndefined();
    expect(importer.consumerForEntry('DI_CONNECT/DI-Connect-Fitness/private_summarizedActivities.json')).toBeUndefined();
    expect(importer.consumerForEntry('DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_Part1.zip')).toBeUndefined();
    const consumer = importer.consumerForEntry(paths.daily)!;
    expect(() => consumer(new TextEncoder().encode('[{"calendarDate":'), true)).toThrow('Incomplete');
  });
});
