import { getSupportedType } from './appleHealthTypes';
import type { HealthRecord } from './models';
import type { SupportedTypeKey } from './appleHealthTypes';

const MAX_UNFINISHED_RECORD_CHARS = 1_000_000;
const RECORD_START = /<Record(?:\s|\/|>)/;
export type AppleHealthRecordSelector = (typeKey: SupportedTypeKey, startDate: string, endDate: string) => boolean;

export class AppleHealthXmlRecordParser {
  private pending = '';
  private sawHealthData = false;
  private rootProbe = '';

  push(chunk: string, onRecord: (record: HealthRecord) => void, selector?: AppleHealthRecordSelector): void {
    // Apple exports can have a large DOCTYPE before the root element. Keep only
    // a tiny boundary probe, but inspect every chunk for the actual root tag.
    const rootCandidate = this.rootProbe + chunk;
    if (/<HealthData(?:\s|>)/.test(rootCandidate)) this.sawHealthData = true;
    this.rootProbe = rootCandidate.slice(-32);
    this.pending += chunk;
    let searchFrom = 0;

    while (true) {
      const remaining = this.pending.slice(searchFrom);
      const startMatch = RECORD_START.exec(remaining);
      if (!startMatch || startMatch.index === undefined) {
        this.pending = this.pending.slice(Math.max(0, this.pending.length - 64));
        return;
      }

      const start = searchFrom + startMatch.index;
      const bounds = findRecordBounds(this.pending, start);
      if (!bounds) {
        if (this.pending.length - start > MAX_UNFINISHED_RECORD_CHARS) {
          throw new Error('Een Record-element is onredelijk groot of onjuist afgesloten.');
        }
        this.pending = this.pending.slice(start);
        return;
      }

      // Apple Health may put MetadataEntry children in a Record. Only its opening
      // tag carries the fields we export; recordEnd skips those children safely.
      const candidate = this.pending.slice(start, bounds.openTagEnd);
      const record = parseAppleHealthRecord(candidate, selector);
      if (record) onRecord(record);
      searchFrom = bounds.recordEnd;
      if (searchFrom >= this.pending.length) {
        this.pending = '';
        return;
      }
    }
  }

  finish(): void {
    if (!this.sawHealthData) {
      throw new Error('Ongeldig invoerbestand: geen Apple Health HealthData-document gevonden.');
    }
    if (RECORD_START.test(this.pending)) {
      throw new Error('Ongeldig XML-bestand: een Record-element is niet afgesloten.');
    }
    this.pending = '';
    this.rootProbe = '';
    this.sawHealthData = false;
  }
}

function findRecordBounds(source: string, start: number): { openTagEnd: number; recordEnd: number } | undefined {
  let quoted = false;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '"') quoted = !quoted;
    if (!quoted && source[index] === '>') {
      const openTagEnd = index + 1;
      if (source.slice(start, openTagEnd).trimEnd().endsWith('/>')) {
        return { openTagEnd, recordEnd: openTagEnd };
      }
      const closeMatch = /<\/Record\s*>/.exec(source.slice(openTagEnd));
      if (!closeMatch || closeMatch.index === undefined) return undefined;
      return { openTagEnd, recordEnd: openTagEnd + closeMatch.index + closeMatch[0].length };
    }
  }
  return undefined;
}

export function parseAppleHealthRecord(element: string, selector?: AppleHealthRecordSelector): HealthRecord | undefined {
  if (!element.startsWith('<Record') || !element.endsWith('>')) {
    throw new Error('Ongeldig Apple Health Record-element.');
  }
  if (selector) {
    const rawType = extractQuotedAttribute(element, 'type');
    const type = getSupportedType(rawType ? decodeXml(rawType) : undefined);
    if (!type) return undefined;
    const rawStartDate = extractQuotedAttribute(element, 'startDate');
    const rawEndDate = extractQuotedAttribute(element, 'endDate');
    if (!selector(type.key, rawStartDate ? decodeXml(rawStartDate) : '', rawEndDate ? decodeXml(rawEndDate) : '')) return undefined;
  }
  const attributeSource = element.slice('<Record'.length, -1).replace(/\/\s*$/, '');
  const attributes = parseXmlAttributes(attributeSource);
  const type = getSupportedType(attributes.type);
  if (!type) return undefined;

  return {
    identifier: type.id,
    typeKey: type.key,
    outputType: type.outputType,
    startDate: attributes.startDate ?? '',
    endDate: attributes.endDate ?? '',
    value: attributes.value ?? '',
    unit: attributes.unit ?? '',
    sourceName: attributes.sourceName ?? '',
    sourceVersion: attributes.sourceVersion ?? '',
    device: attributes.device ?? ''
  };
}

function extractQuotedAttribute(element: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`).exec(element);
  return match?.[1];
}

export function parseXmlAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const attribute = /([:\w-]+)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  let consumed = '';
  while ((match = attribute.exec(source)) !== null) {
    attributes[match[1]] = decodeXml(match[2]);
    consumed += match[0];
  }
  // An attribute must be quoted XML. Reject anything other than whitespace between attributes.
  if (source.replace(attribute, '').trim() !== '' || consumed.length === 0) {
    throw new Error('Ongeldig XML-attribuut in een Record-element.');
  }
  return attributes;
}

function decodeXml(value: string): string {
  return value.replace(/&(?:quot|apos|lt|gt|amp);|&#(\d+);|&#x([\da-fA-F]+);/g, (entity, decimal, hexadecimal) => {
    if (decimal) return String.fromCodePoint(Number(decimal));
    if (hexadecimal) return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
    return ({ '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' } as Record<string, string>)[entity] ?? entity;
  });
}
