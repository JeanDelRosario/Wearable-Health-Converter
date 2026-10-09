export const CSV_HEADER = ['category', 'date', 'value', 'unit', 'source', 'measurement_type'];

export interface CsvSummaryRow {
  category: string;
  date: string;
  value: string;
  unit: string;
  source?: string;
  measurementType?: string;
}

export function escapeCsvField(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function summaryRowToCsv(row: CsvSummaryRow): string {
  return [row.category, row.date, row.value, row.unit, row.source ?? '', row.measurementType ?? ''].map(escapeCsvField).join(',');
}

export function csvPreamble(): string {
  // BOM makes UTF-8 CSV open correctly in common spreadsheet applications.
  return `\uFEFF${CSV_HEADER.join(',')}\r\n`;
}
