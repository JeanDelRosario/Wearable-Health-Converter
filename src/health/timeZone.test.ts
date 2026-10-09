import { describe, expect, it } from 'vitest';
import { dateInTimeZone, midnightInTimeZone, validateTimeZone } from './timeZone';

describe('timezone handling', () => {
  it('groups an instant consistently regardless of the host timezone', () => {
    const instant = Date.parse('2026-09-01T23:00:00Z');
    expect(dateInTimeZone(instant, 'Europe/Amsterdam')).toBe('2026-09-02');
    expect(dateInTimeZone(instant, 'UTC')).toBe('2026-09-01');
  });
  it('finds correct midnights across 23- and 25-hour DST days', () => {
    expect(midnightInTimeZone('2026-03-30', 'Europe/Amsterdam') - midnightInTimeZone('2026-03-29', 'Europe/Amsterdam')).toBe(23 * 3_600_000);
    expect(midnightInTimeZone('2026-10-26', 'Europe/Amsterdam') - midnightInTimeZone('2026-10-25', 'Europe/Amsterdam')).toBe(25 * 3_600_000);
    expect(validateTimeZone('not/a/timezone')).toBe(false);
  });
});
