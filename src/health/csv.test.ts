import { describe, expect, it } from 'vitest';
import { csvPreamble, escapeCsvField, summaryRowToCsv } from './csv';

describe('CSV exporter', () => {
  it('escapes quotes, commas and line breaks correctly', () => {
    expect(escapeCsvField('a,"b"\nnext')).toBe('"a,""b""\nnext"');
  });

  it('creates a compact documented header and daily summary row', () => {
    expect(csvPreamble()).toBe('\uFEFFcategory,date,value,unit,source,measurement_type\r\n');
    expect(summaryRowToCsv({ category: 'HRV', date: '2026-01-01', value: '42.5', unit: 'ms' }))
      .toBe('"HRV","2026-01-01","42.5","ms","",""');
  });
});
