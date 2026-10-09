import { describe, expect, it } from 'vitest';
import { getCalendarDates, getStartDateFor28DayWindow } from './dateRange';

describe('28-day date range', () => {
  it('includes the selected end date in a 28 calendar-day period', () => {
    expect(getStartDateFor28DayWindow('2026-09-20')).toBe('2026-08-24');
  });

  it('crosses month and leap-year boundaries correctly', () => {
    expect(getStartDateFor28DayWindow('2028-03-01')).toBe('2028-02-03');
  });

  it('rejects malformed dates', () => {
    expect(getStartDateFor28DayWindow('20-09-2026')).toBeUndefined();
    expect(getStartDateFor28DayWindow('2026-02-30')).toBeUndefined();
  });

  it('lists the inclusive calendar dates in chronological order', () => {
    expect(getCalendarDates('2026-09-29', '2026-10-01')).toEqual(['2026-09-29', '2026-09-30', '2026-10-01']);
  });
});
