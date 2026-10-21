import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { processHealthFile } from './processing';
import { MEASUREMENT_TYPES } from './measurementTypes';
import type { ProcessingOptions, ProgressUpdate } from './models';

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

  it('imports Celsius wrist temperature with Apple metadata and reports progress within a large zipped XML', async () => {
    const temperatureXml = `<HealthData locale="nl_NL">${'<!-- padding -->'.repeat(20_000)}
<Record type="HKQuantityTypeIdentifierAppleSleepingWristTemperature" sourceName="Apple Watch" sourceVersion="12.0" device="&lt;HKDevice: Synthetic Watch&gt;" unit="degC" startDate="2026-09-19 23:00:00 +0200" endDate="2026-09-20 07:00:00 +0200" value="35.8">
  <MetadataEntry key="HKMetadataKeySyncIdentifier" value="synthetic-only"/>
</Record>
<Record type="HKQuantityTypeIdentifierAppleSleepingWristTemperature" unit="degC" startDate="2026-09-20 08:00:00 +0200" endDate="2026-09-20 09:00:00 +0200" value="36.2"/>
<Record type="HKQuantityTypeIdentifierBodyTemperature" unit="degC" startDate="2026-09-20 10:00:00 +0200" endDate="2026-09-20 10:00:00 +0200" value="37.5"/>
</HealthData>`;
    const bytes = strToU8(temperatureXml);
    const zip = zipSync({ 'apple_health_export/Export.xml': bytes, 'apple_health_export/export_cda.xml': strToU8('not parsed') }, { level: 0 });
    const updates: ProgressUpdate[] = [];
    const result = await processHealthFile(new File([zip], 'Apple.zip'), options, (p) => updates.push(p));
    expect(find(result, 'Nightly temperature')).toMatchObject({ value: '36.00', unit: '°C', source: 'Apple Health' });
    expect(find(result, 'Nightly temperature', '2026-09-19').value).toBe('');
    expect(find(result, 'Nightly temperature').measurementType).toBe('sleeping_wrist_temperature;sample_mean;sample_end_date');
    expect(find(result, 'Temperature deviation').value).toBe('');
    expect(result.recordsMatched).toBe(2);
    expect(updates.some((p) => p.bytesRead > 0 && p.bytesRead < p.totalBytes)).toBe(true);
    expect(updates.every((p) => p.phase === 'parsing' && p.totalBytes === bytes.length)).toBe(true);
    expect(updates.at(-1)?.bytesRead).toBe(bytes.length);
    expect(updates.every((p, index) => index === 0 || p.bytesRead >= updates[index - 1].bytesRead)).toBe(true);
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

  it('detects wrapped Garmin exports and skips personal files and nested FIT archives', async () => {
    const zip = zipSync({
      'wrapper/DI_CONNECT/DI-Connect-Aggregator/UDSFile_2026-07-01_2026-10-09.json': strToU8(JSON.stringify([{ calendarDate: '2026-09-20', totalSteps: 456, currentDayRestingHeartRate: 55 }])),
      'wrapper/customer_data/customer.json': strToU8('{invalid'),
      'wrapper/DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_Part1.zip': strToU8('not a zip')
    });
    const result = await processHealthFile(new File([zip], 'Garmin.zip'), options);
    expect(result.platform).toBe('Garmin');
    expect(result.rows).toHaveLength(168);
    expect(find(result, 'Steps').value).toBe('456');
    expect(find(result, 'Resting heart rate').value).toBe('55');
    expect(result.rows.every(r => !r.source?.includes('wrapper'))).toBe(true);
  });

  it('detects Samsung exports and skips macOS resource forks and unrelated personal CSVs', async () => {
    const csv = 'com.samsung.shealth.step_daily_trend,7006011,6\nday_time,source_type,count\n2026-09-20 00:00:00.000,-2,123,\n';
    const zip = zipSync({
      'wrapper/com.samsung.shealth.step_daily_trend.20261011202615.csv': strToU8(csv),
      '__MACOSX/._com.samsung.shealth.step_daily_trend.20261011202615.csv': new Uint8Array([0, 1, 255]),
      'com.samsung.health.user_profile.20261011202615.csv': strToU8('private invalid data')
    });
    const result = await processHealthFile(new File([zip], 'Samsung.zip'), options);
    expect(result.platform).toBe('Samsung Health');
    expect(find(result, 'Steps').value).toBe('123');
    expect(result.rows).toHaveLength(168);
    const mixed = zipSync({ 'com.samsung.shealth.step_daily_trend.csv': strToU8(csv), 'export.xml': strToU8(xml) });
    await expect(processHealthFile(new File([mixed], 'mixed.zip'), options)).rejects.toThrow('multiple wearable platforms');
  });

  it('detects WHOOP and ignores journals, workouts and macOS resource forks', async () => {
    const whoop = { 'wrapper/physiological_cycles.csv': strToU8('Cycle start time,Cycle timezone,Sleep onset,Wake onset,Resting heart rate (bpm),Heart rate variability (ms),Skin temp (celsius)\n2026-09-19 22:00:00,UTC+02:00,2026-09-19 22:00:00,2026-09-20 06:00:00,55,60,33.2\n') };
    const zip = zipSync({ ...whoop, 'journal_entries.csv': strToU8('private invalid csv'), 'workouts.csv': strToU8('private invalid csv'), '__MACOSX/._physiological_cycles.csv': new Uint8Array([255]) });
    const result = await processHealthFile(new File([zip], 'WHOOP.zip'), options);
    expect(result.platform).toBe('WHOOP');
    expect(result.rows).toHaveLength(168);
    expect(find(result, 'Nightly temperature').value).toBe('33.2');
    const others: Record<string, Uint8Array>[] = [
      { 'export.xml': strToU8(xml) },
      { 'Google Health/Physical Activity_GoogleData/daily_resting_heart_rate.csv': strToU8('timestamp,beats per minute\n') },
      { 'DI_CONNECT/DI-Connect-Aggregator/UDSFile_2026-07-01_2026-10-09.json': strToU8('[]') },
      { 'com.samsung.shealth.step_daily_trend.csv': strToU8('com.samsung.shealth.step_daily_trend,7006011,6\nday_time,source_type,count\n') }
    ];
    for (const other of others) await expect(processHealthFile(new File([zipSync({ ...whoop, ...other })], 'mixed.zip'), options)).rejects.toThrow('multiple wearable platforms');
  });

  it('rejects Garmin mixed with Apple or Google and archives without supported daily summaries', async () => {
    const garminEntry = { 'DI_CONNECT/DI-Connect-Aggregator/UDSFile_2026-07-01_2026-10-09.json': strToU8('[]') };
    const otherEntries: Record<string, Uint8Array>[] = [{ 'export.xml': strToU8(xml) }, { 'Google Health/Physical Activity_GoogleData/daily_resting_heart_rate.csv': strToU8('timestamp,beats per minute\n') }];
    for (const other of otherEntries) {
      const zip = zipSync({ ...garminEntry, ...other });
      await expect(processHealthFile(new File([zip], 'mixed.zip'), options)).rejects.toThrow('multiple wearable platforms');
    }
    const zip = zipSync({ 'private.json': strToU8('{}') });
    await expect(processHealthFile(new File([zip], 'unsupported.zip'), options)).rejects.toThrow('No supported');
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
