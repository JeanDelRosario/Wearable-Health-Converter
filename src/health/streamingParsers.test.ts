import { describe, expect, it } from 'vitest';
import { CsvStreamParser, JsonArrayStreamParser } from './streamingParsers';

describe('incremental parsers', () => {
  it('handles quoted commas, quotes, embedded newlines, and chunk boundaries', () => {
    const rows: string[][] = [];
    const p = new CsvStreamParser((row) => rows.push(row));
    for (const c of 'a,b\r\n"one,""two""","line\nnext"\r\n') p.push(c);
    p.finish(); expect(rows).toEqual([['a', 'b'], ['one,"two"', 'line\nnext']]);
  });
  it('rejects unfinished and oversized CSV rows', () => {
    const p = new CsvStreamParser(() => {}); p.push('"unfinished'); expect(() => p.finish()).toThrow('Unclosed');
    expect(() => new CsvStreamParser(() => {}).push('x'.repeat(1_000_001))).toThrow('limit');
  });
  it('streams nested JSON objects without treating brackets in strings as delimiters', () => {
    const rows: Record<string, unknown>[] = [];
    const objects = [{ a: 'braces } [ " quotes', b: [{ n: 1 }] }, { a: 'next' }];
    const p = new JsonArrayStreamParser((r) => rows.push(r));
    for (const c of JSON.stringify(objects)) p.push(c);
    p.finish(); expect(rows).toEqual(objects);
  });
  it('rejects truncated JSON, trailing commas, and trailing content', () => {
    const p = new JsonArrayStreamParser(() => {}); p.push('[{"a":1}'); expect(() => p.finish()).toThrow('Incomplete');
    for (const input of ['[{"a":1},]', '[{"a":1}]x']) expect(() => new JsonArrayStreamParser(() => {}).push(input)).toThrow();
  });
});
