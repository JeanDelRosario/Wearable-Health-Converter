import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AppleHealthXmlRecordParser, parseAppleHealthRecord } from './xmlRecordParser';
import type { HealthRecord } from './models';

const fixture = readFileSync(new URL('./__fixtures__/apple-health-export.xml', import.meta.url), 'utf-8');

describe('AppleHealthXmlRecordParser', () => {
  it('parses supported records across arbitrary chunks and ignores unknown types', () => {
    const parser = new AppleHealthXmlRecordParser();
    const records: HealthRecord[] = [];
    for (let index = 0; index < fixture.length; index += 37) {
      parser.push(fixture.slice(index, index + 37), (record) => records.push(record));
    }
    parser.finish();

    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({ outputType: 'heart_rate_variability_sdnn', sourceName: 'Watch & Phone', device: '<HKDevice: Watch>' });
    expect(records[2]).toMatchObject({ outputType: 'sleep_analysis', unit: '', sourceVersion: '' });
  });

  it('accepts a Record with child metadata without exporting its metadata', () => {
    const parser = new AppleHealthXmlRecordParser();
    const records: HealthRecord[] = [];
    parser.push('<HealthData><Record type="HKQuantityTypeIdentifierHeartRateVariabilitySDNN" startDate="2026-01-01" value="42"><MetadataEntry key="secret" value="discard"/></Record></HealthData>', (record) => records.push(record));
    parser.finish();
    expect(records).toEqual([expect.objectContaining({ value: '42', startDate: '2026-01-01' })]);
  });

  it('returns undefined for an unknown Apple Health type', () => {
    expect(parseAppleHealthRecord('<Record type="HKQuantityTypeIdentifierBodyMass" value="70"/>')).toBeUndefined();
  });

  it('can reject an unselected record before its full attributes are decoded', () => {
    expect(parseAppleHealthRecord('<Record type="HKQuantityTypeIdentifierHeartRateVariabilitySDNN" startDate="2026-01-01" malformed="not relevant"/>', () => false)).toBeUndefined();
  });

  it('rejects invalid attributes and unfinished XML records', () => {
    expect(() => parseAppleHealthRecord('<Record type=HKQuantityTypeIdentifierHeartRateVariabilitySDNN/>')).toThrow('Ongeldig XML-attribuut');
    const parser = new AppleHealthXmlRecordParser();
    parser.push('<HealthData><Record type="HKQuantityTypeIdentifierHeartRateVariabilitySDNN"', () => undefined);
    expect(() => parser.finish()).toThrow('niet afgesloten');
  });

  it('rejects a non-Apple-Health XML document', () => {
    const parser = new AppleHealthXmlRecordParser();
    parser.push('<not-health-data/>', () => undefined);
    expect(() => parser.finish()).toThrow('geen Apple Health');
  });

  it('recognizes HealthData after a large XML declaration block', () => {
    const parser = new AppleHealthXmlRecordParser();
    const records: HealthRecord[] = [];
    parser.push(`<!DOCTYPE HealthData [${'x'.repeat(10_000)}]><Health`, (record) => records.push(record));
    parser.push('Data><Record type="HKQuantityTypeIdentifierHeartRateVariabilitySDNN" value="42"/></HealthData>', (record) => records.push(record));
    parser.finish();
    expect(records).toEqual([expect.objectContaining({ value: '42' })]);
  });
});
