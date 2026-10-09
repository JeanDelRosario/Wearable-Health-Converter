import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { processHealthFile } from './processing';
import { MEASUREMENT_TYPES } from './measurementTypes';
import type { ProcessingOptions } from './models';

const options: ProcessingOptions = { selectedTypes: Object.keys(MEASUREMENT_TYPES) as ProcessingOptions['selectedTypes'], startDate: '2026-08-24', endDate: '2026-09-20', timeZone: 'Europe/Amsterdam' };
const xml = `<HealthData>
<Record type="HKQuantityTypeIdentifierHeartRateVariabilitySDNN" startDate="2026-09-20 07:00:00 +0200" value="40" unit="ms"/>
<Record type="HKQuantityTypeIdentifierRestingHeartRate" startDate="2026-09-20 07:00:00 +0200" value="60" unit="count/min"/>
<Record type="HKQuantityTypeIdentifierAppleSleepingWristTemperature" startDate="2026-09-19 23:00:00 +0200" endDate="2026-09-20 07:00:00 +0200" value="86" unit="degF"/>
<Record type="HKQuantityTypeIdentifierStepCount" startDate="2026-09-19 23:30:00 +0200" endDate="2026-09-20 00:30:00 +0200" value="120" sourceName="Apple Watch"/>
<Record type="HKCategoryTypeIdentifierSleepAnalysis" startDate="2026-09-19 23:00:00 +0200" endDate="2026-09-20 07:00:00 +0200" value="HKCategoryValueSleepAnalysisAsleepCore"/>
</HealthData>`;
const find = (result: Awaited<ReturnType<typeof processHealthFile>>, category: string, date = '2026-09-20') => result.rows.find((r) => r.category === category && r.date === date)!;

describe('end-to-end file processing', () => {
  it('processes Apple XML with SDNN provenance, Fahrenheit conversion, and no invented baseline', async () => {
    const file = new File([xml], 'export.xml');
    // Safari-compatible path must not rely on File.stream().
    Object.defineProperty(file, 'stream', { value: () => { throw new Error('stream must not be called'); } });
    const result = await processHealthFile(file, options);
    expect(result.rows).toHaveLength(168);
    expect(find(result, 'Nightly temperature')).toMatchObject({ value: '30.00', source: 'Apple Health' });
    expect(find(result, 'Temperature deviation').value).toBe('');
    expect(find(result, 'HRV').measurementType).toContain('sdnn');
    expect(find(result, 'Steps').value).toBe('60');
    expect(find(result, 'Steps', '2026-09-19').value).toBe('60');
    expect(find(result, 'Sleep duration').value).toBe('480');
    expect(result.warnings).toContainEqual({ code: 'apple_no_baseline' });
  });

  it('processes zipped XML across compressed chunk boundaries and skips unrelated content', async () => {
    const large = '<HealthData>' + '<!-- ignored -->'.repeat(20_000) + xml.slice('<HealthData>'.length);
    const zip = zipSync({ 'apple_health_export/export.xml': strToU8(large), 'unrelated/not-a-json.json': strToU8('{invalid') }, { level: 0 });
    const result = await processHealthFile(new File([zip], 'Apple.zip'), options);
    expect(find(result, 'HRV').value).toBe('40');
  });

  it('detects wrapped Google archives and does not parse unrelated personal files', async () => {
    const zip = zipSync({
      'Takeout/Google Health/Physical Activity_GoogleData/daily_resting_heart_rate.csv': strToU8('timestamp,beats per minute\n2026-09-20T00:00:00Z,65.451\n'),
      'Takeout/Google Health/Your Profile/private.json': strToU8('not valid JSON')
    });
    const result = await processHealthFile(new File([zip], 'Google.zip'), options);
    expect(result.platform).toBe('Google/Fitbit');
    expect(find(result, 'Resting heart rate').value).toBe('65.451');
  });

  it('rejects malformed files, invalid date windows, empty files and mixed-platform archives', async () => {
    await expect(processHealthFile(new File(['not XML'], 'export.xml'), options)).rejects.toThrow('geen Apple');
    await expect(processHealthFile(new File([], 'export.xml'), options)).rejects.toThrow('empty');
    await expect(processHealthFile(new File([xml], 'export.xml'), { ...options, startDate: '2026-09-01' })).rejects.toThrow('28-day');
    const zip = zipSync({ 'export.xml': strToU8(xml), 'Google Health/Physical Activity_GoogleData/daily_resting_heart_rate.csv': strToU8('timestamp,beats per minute\n') });
    await expect(processHealthFile(new File([zip], 'mixed.zip'), options)).rejects.toThrow('Apple and Google');
    await expect(processHealthFile(new File([xml], 'export.xml'), options, () => {}, () => true)).rejects.toThrow('cancelled');
  });

  it.skipIf(!process.env.WEARABLE_TEST_GOOGLE_ZIP)('converts a supplied Google export without including private data in source fixtures', async () => {
    const bytes = readFileSync(process.env.WEARABLE_TEST_GOOGLE_ZIP!);
    const result = await processHealthFile(new File([bytes], 'Google Health.zip'), options);
    expect(result.platform).toBe('Google/Fitbit');
    expect(result.rows).toHaveLength(168);
    expect(result.rows.filter((r) => r.value !== '').length).toBeGreaterThan(100);
    expect(result.rows.every((r) => r.value === '' || Number.isFinite(Number(r.value)))).toBe(true);
  });
});
