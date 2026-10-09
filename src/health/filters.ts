import type { HealthRecord, ProcessingOptions } from './models';
import type { SupportedTypeKey } from './appleHealthTypes';

/** Filters on the calendar date at the beginning of an Apple Health sample, inclusively. */
export function recordMatchesFilters(record: HealthRecord, options: ProcessingOptions): boolean {
  return typeAndDateMatches(record.typeKey, record.startDate, options);
}

/** Lightweight equivalent for the streaming parser, before a full record is materialized. */
export function typeAndDateMatches(typeKey: SupportedTypeKey, startDate: string, options: ProcessingOptions): boolean {
  if (!options.selectedTypes.includes(typeKey)) return false;

  const calendarDate = startDate.slice(0, 10);
  if (options.startDate && (!calendarDate || calendarDate < options.startDate)) return false;
  if (options.endDate && (!calendarDate || calendarDate > options.endDate)) return false;
  return true;
}

/** Includes a record when any part of its time interval touches the selected calendar range. */
export function intervalOverlapsDateRange(startDate: string, endDate: string, options: ProcessingOptions): boolean {
  const start = startDate.slice(0, 10);
  const end = (endDate || startDate).slice(0, 10);
  if (!start || !end) return false;
  if (options.startDate && end < options.startDate) return false;
  if (options.endDate && start > options.endDate) return false;
  return true;
}

export function validateDateRange(options: ProcessingOptions): string | undefined {
  if (options.startDate && options.endDate && options.startDate > options.endDate) {
    return 'De startdatum mag niet na de einddatum liggen.';
  }
  return undefined;
}
