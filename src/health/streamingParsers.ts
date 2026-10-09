/** Small incremental parsers: retain at most one CSV row or JSON object. */
export class CsvStreamParser {
  private field = '';
  private row: string[] = [];
  private state: 'plain' | 'quoted' | 'closed' = 'plain';
  private skipLf = false;
  private size = 0;
  constructor(private readonly emit: (row: string[]) => void) {}

  push(text: string): void {
    for (const c of text) {
      if (++this.size > 1_000_000) throw new Error('CSV row exceeds the 1 MB limit.');
      if (this.skipLf) { this.skipLf = false; if (c === '\n') continue; }
      if (this.state === 'quoted') {
        if (c === '"') this.state = 'closed'; else this.field += c;
      } else if (this.state === 'closed' && c === '"') {
        this.field += '"'; this.state = 'quoted';
      } else if (c === ',') {
        this.row.push(this.field); this.field = ''; this.state = 'plain';
      } else if (c === '\r' || c === '\n') {
        this.endRow(); this.skipLf = c === '\r';
      } else if (this.state === 'closed') {
        if (c !== ' ' && c !== '\t') throw new Error('Unexpected character after a quoted CSV field.');
      } else if (c === '"') {
        if (this.field) throw new Error('Unexpected quote in CSV field.');
        this.state = 'quoted';
      } else this.field += c;
    }
  }

  finish(): void {
    if (this.state === 'quoted') throw new Error('Unclosed quoted CSV field.');
    if (this.field || this.row.length) this.endRow();
  }

  private endRow(): void {
    this.row.push(this.field);
    if (this.row.some((v) => v !== '')) this.emit(this.row);
    this.row = []; this.field = ''; this.state = 'plain'; this.size = 0;
  }
}

export class JsonArrayStreamParser {
  private state: 'start' | 'first' | 'value' | 'separator' | 'done' = 'start';
  private token = '';
  private depth = 0;
  private quoted = false;
  private escaped = false;
  constructor(private readonly emit: (record: Record<string, unknown>) => void) {}

  push(text: string): void {
    for (const c of text) {
      if (this.depth) {
        this.token += c;
        if (this.token.length > 2_000_000) throw new Error('JSON record exceeds the 2 MB limit.');
        if (this.quoted) {
          if (this.escaped) this.escaped = false;
          else if (c === '\\') this.escaped = true;
          else if (c === '"') this.quoted = false;
        } else if (c === '"') this.quoted = true;
        else if (c === '{' || c === '[') this.depth++;
        else if (c === '}' || c === ']') this.depth--;
        if (!this.depth) {
          this.emit(JSON.parse(this.token) as Record<string, unknown>);
          this.token = ''; this.state = 'separator';
        }
        continue;
      }
      if (/\s|\uFEFF/.test(c)) continue;
      if (this.state === 'start' && c === '[') this.state = 'first';
      else if ((this.state === 'first' || this.state === 'separator') && c === ']') this.state = 'done';
      else if (this.state === 'separator' && c === ',') this.state = 'value';
      else if ((this.state === 'first' || this.state === 'value') && c === '{') {
        this.token = '{'; this.depth = 1;
      } else throw new Error('Expected a JSON array of records.');
    }
  }

  finish(): void {
    if (this.depth || this.state !== 'done') throw new Error('Incomplete JSON array.');
  }
}

export function csvObjectConsumer(required: string[], emit: (row: Record<string, string>) => void) {
  let headers: string[] | undefined;
  const parser = new CsvStreamParser((fields) => {
    if (!headers) {
      headers = fields.map((v) => v.replace(/^\uFEFF/, '').trim());
      if (new Set(headers).size !== headers.length || required.some((v) => !headers!.includes(v))) {
        throw new Error(`CSV is missing expected columns: ${required.join(', ')}.`);
      }
    } else {
      if (fields.length !== headers.length) throw new Error('CSV row has an unexpected number of fields.');
      emit(Object.fromEntries(headers.map((h, i) => [h, fields[i]])));
    }
  });
  return { push: (text: string) => parser.push(text), finish: () => {
    parser.finish(); if (!headers) throw new Error('CSV has no header.');
  } };
}
