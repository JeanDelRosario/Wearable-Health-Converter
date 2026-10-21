import { readZipDirectory, consumeZipEntry } from './zipReader';
import { createDailySummary, addRecordToDailySummary, createDailySummaryRows } from './dailySummary';
import { AppleHealthXmlRecordParser } from './xmlRecordParser';
import { GoogleHealthImporter } from './googleHealthImporter';
import { GarminHealthImporter } from './garminHealthImporter';
import { SamsungHealthImporter } from './samsungHealthImporter';
import { WhoopHealthImporter } from './whoopHealthImporter';
import { intervalOverlapsDateRange, typeAndDateMatches, validateDateRange } from './filters';
import type { CsvSummaryRow } from './csv';
import type { ImportWarning, ProcessingOptions, ProgressUpdate } from './models';
import { getStartDateFor28DayWindow } from './dateRange';
import { validateTimeZone } from './timeZone';

export interface ProcessingResult {
  rows: CsvSummaryRow[];
  warnings: ImportWarning[];
  platform: 'Apple Health' | 'Google/Fitbit' | 'Garmin' | 'Samsung Health' | 'WHOOP';
  recordsMatched: number;
}

/** Slice-based reads avoid File.stream() and never queue a full inflated XML. */
export async function processHealthFile(file: File, options: ProcessingOptions,
  report: (progress: ProgressUpdate) => void = () => {}, isCancelled: () => boolean = () => false
): Promise<ProcessingResult> {
  const validation = validateDateRange(options);
  if (validation) throw new Error(validation);
  if (!options.endDate || getStartDateFor28DayWindow(options.endDate) !== options.startDate) throw new Error('Choose a valid 28-day date window.');
  if (!options.selectedTypes.length) throw new Error('Select at least one measurement.');
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!validateTimeZone(timeZone)) throw new Error('Choose a valid IANA timezone, for example Europe/Amsterdam.');
  options = { ...options, timeZone };
  const summary = createDailySummary();
  const parser = new AppleHealthXmlRecordParser();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const google = new GoogleHealthImporter(options);
  const garmin = new GarminHealthImporter(options);
  const samsung = new SamsungHealthImporter(options);
  const whoop = new WhoopHealthImporter(options);
  let appleFound = false;
  let matched = 0;
  let xmlFinished = false;
  let xmlBytesRead = 0;
  let xmlTotalBytes = file.size;
  let lastXmlPercent = -1;
  const appleConsumer = (data: Uint8Array, final: boolean) => {
    parser.push(decoder.decode(data, { stream: !final }), (record) => {
      addRecordToDailySummary(summary, record); matched++;
    }, (key, start, end) => {
      if (!options.selectedTypes.includes(key)) return false;
      if (key === 'stepCount') return intervalOverlapsDateRange(start, end, options);
      return typeAndDateMatches(key, key === 'sleepAnalysis' || key === 'wristTemperature' ? end || start : start, options);
    });
    if (final) { parser.finish(); xmlFinished = true; }
    xmlBytesRead += data.length;
    const percent = Math.floor(xmlBytesRead / xmlTotalBytes * 100);
    if (percent !== lastXmlPercent || final) {
      lastXmlPercent = percent;
      report({ phase: 'parsing', bytesRead: xmlBytesRead, totalBytes: xmlTotalBytes, recordsMatched: matched });
    }
  };
  const isZip = /\.zip$/i.test(file.name) || file.type === 'application/zip';
  if (isZip) {
    const entries = await readZipDirectory(file);
    for (const [index, entry] of entries.entries()) {
      if (isCancelled()) throw new Error('Processing cancelled.');
      const path = entry.name.replaceAll('\\', '/');
      let consumer: ((bytes: Uint8Array, final: boolean) => void) | undefined;
      if (/(?:^|\/)export\.xml$/i.test(path)) {
        if (appleFound) throw new Error('Multiple export.xml files found. Select one export.xml directly.');
        appleFound = true; xmlTotalBytes = entry.originalSize; consumer = appleConsumer;
      } else consumer = google.consumerForEntry(path) ?? garmin.consumerForEntry(path) ?? samsung.consumerForEntry(path) ?? whoop.consumerForEntry(path);
      if (consumer) {
        try { await consumeZipEntry(file, entry, consumer, isCancelled); }
        catch (e) { throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`); }
      }
      if (!appleFound) report({ phase: 'reading', bytesRead: index + 1, totalBytes: entries.length, recordsMatched: matched + google.recordsMatched + garmin.recordsMatched + samsung.recordsMatched + whoop.recordsMatched });
    }
  } else {
    if (!/\.xml$/i.test(file.name)) throw new Error('Choose an Apple XML or an Apple/Google/Fitbit/Garmin/Samsung/WHOOP ZIP export.');
    appleFound = true;
    const chunkSize = 64 * 1024;
    for (let offset = 0; offset < file.size; offset += chunkSize) {
      if (isCancelled()) throw new Error('Processing cancelled.');
      const bytes = new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer());
      appleConsumer(bytes, offset + bytes.length === file.size);
    }
  }
  if (!file.size) throw new Error('The selected file is empty.');
  if (whoop.recognizedEntries && (appleFound || google.recognizedEntries || garmin.recognizedEntries || samsung.recognizedEntries)) throw new Error('This archive contains multiple wearable platforms. Export each platform separately.');
  if (whoop.recognizedEntries) return { rows: whoop.finish(), warnings: whoop.warnings, platform: 'WHOOP', recordsMatched: whoop.recordsMatched };
  if (appleFound && google.recognizedEntries) throw new Error('This archive contains Apple and Google data. Export each platform separately.');
  if (samsung.recognizedEntries && (appleFound || google.recognizedEntries || garmin.recognizedEntries)) throw new Error('This archive contains multiple wearable platforms. Export each platform separately.');
  if (samsung.recognizedEntries) return { rows: samsung.finish(), warnings: samsung.warnings, platform: 'Samsung Health', recordsMatched: samsung.recordsMatched };
  if (garmin.recognizedEntries && (appleFound || google.recognizedEntries)) throw new Error('This archive contains multiple wearable platforms. Export each platform separately.');
  if (garmin.recognizedEntries) return { rows: garmin.finish(), warnings: garmin.warnings, platform: 'Garmin', recordsMatched: garmin.recordsMatched };
  if (!appleFound && !google.recognizedEntries) throw new Error('No supported Apple Health, Google/Fitbit, Garmin, Samsung or WHOOP summary files found in this ZIP.');
  if (!appleFound) return { rows: google.finish(), warnings: google.warnings, platform: 'Google/Fitbit', recordsMatched: google.recordsMatched };
  if (!xmlFinished) throw new Error('The Apple XML was not completely read.');
  const rows = createDailySummaryRows(summary, options.selectedTypes, options.startDate!, options.endDate!, timeZone).map((row) => ({
    ...row, source: 'Apple Health', measurementType: {
      'Sleep duration': 'sleep_duration;union_asleep_intervals;sample_end_date',
      'Steps': `step_count;apple_watch_priority_6min_guard;timezone=${timeZone}`,
      'HRV': 'heart_rate_variability_sdnn;sample_mean',
      'Resting heart rate': 'resting_heart_rate;sample_mean',
      'Nightly temperature': 'sleeping_wrist_temperature;sample_mean;sample_end_date',
      'Temperature deviation': 'sleeping_wrist_temperature_deviation;baseline_not_available'
    }[row.category] ?? ''
  }));
  const warnings: ImportWarning[] = [];
  if (options.selectedTypes.includes('temperatureDeviation')) warnings.push({ code: 'apple_no_baseline' });
  if (!rows.some((r) => r.value !== '')) warnings.push({ code: 'no_measurements' });
  return { rows, warnings, platform: 'Apple Health', recordsMatched: matched };
}
