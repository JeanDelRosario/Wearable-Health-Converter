import { describe, expect, it } from 'vitest';
import { intervalOverlapsDateRange, recordMatchesFilters, typeAndDateMatches, validateDateRange } from './filters';
import type { HealthRecord } from './models';
import type { ProcessingOptions } from './models';

const hrv: HealthRecord = {
  identifier: 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN', typeKey: 'heartRateVariability', outputType: 'heart_rate_variability_sdnn',
  startDate: '2026-01-02 10:00:00 +0100', endDate: '2026-01-02 10:01:00 +0100',
  value: '42', unit: 'ms', sourceName: '', sourceVersion: '', device: ''
};

describe('record filters', () => {
  it('filters on selection and inclusive start-date range', () => {
    expect(recordMatchesFilters(hrv, { selectedTypes: ['heartRateVariability'], startDate: '2026-01-02', endDate: '2026-01-02' })).toBe(true);
    expect(recordMatchesFilters(hrv, { selectedTypes: ['stepCount'] })).toBe(false);
    expect(recordMatchesFilters(hrv, { selectedTypes: ['heartRateVariability'], startDate: '2026-01-03' })).toBe(false);
  });

  it('rejects a reversed date range', () => {
    expect(validateDateRange({ selectedTypes: ['heartRateVariability'], startDate: '2026-02-01', endDate: '2026-01-01' })).toContain('startdatum');
  });

  it('applies the same date and type rule before a full record is created', () => {
    const options: ProcessingOptions = { selectedTypes: ['heartRateVariability'], startDate: '2026-01-02', endDate: '2026-01-02' };
    expect(typeAndDateMatches('heartRateVariability', '2026-01-02 10:00:00 +0100', options)).toBe(true);
    expect(typeAndDateMatches('stepCount', '2026-01-02 10:00:00 +0100', options)).toBe(false);
  });

  it('keeps an interval that overlaps the selected period even when it started the prior day', () => {
    const options: ProcessingOptions = { selectedTypes: ['stepCount'], startDate: '2026-01-02', endDate: '2026-01-02' };
    expect(intervalOverlapsDateRange('2026-01-01 23:55:00 +0100', '2026-01-02 00:05:00 +0100', options)).toBe(true);
    expect(intervalOverlapsDateRange('2026-01-01 22:00:00 +0100', '2026-01-01 23:00:00 +0100', options)).toBe(false);
  });
});
