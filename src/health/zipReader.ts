import { Inflate } from 'fflate';

export interface ZipEntry {
  name: string; compression: number; flags: number; crc: number;
  compressedSize: number; originalSize: number; offset: number;
}
const signature = (view: DataView, offset: number) => view.getUint32(offset, true);
function safe64(view: DataView, offset: number): number {
  const value = Number(view.getBigUint64(offset, true));
  if (!Number.isSafeInteger(value)) throw new Error('ZIP offset exceeds the supported range.');
  return value;
}
async function read(file: Blob, start: number, length: number): Promise<Uint8Array> {
  if (start < 0 || length < 0 || start + length > file.size) throw new Error('ZIP is truncated or has invalid offsets.');
  const result = new Uint8Array(await file.slice(start, start + length).arrayBuffer());
  if (result.length !== length) throw new Error('ZIP could not be read completely.');
  return result;
}

/** Read the small directory; skipped file contents are never read or inflated. */
export async function readZipDirectory(file: Blob): Promise<ZipEntry[]> {
  const tail = await read(file, Math.max(0, file.size - 65557), Math.min(file.size, 65557));
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let end = tail.length - 22;
  for (; end >= 0; end--) {
    if (signature(view, end) === 0x06054b50 && end + 22 + view.getUint16(end + 20, true) === tail.length) break;
  }
  if (end < 0) throw new Error('ZIP directory not found. Select a complete ZIP export.');
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw new Error('Split ZIP archives are not supported.');
  let count = view.getUint16(end + 10, true);
  let size = view.getUint32(end + 12, true);
  let offset = view.getUint32(end + 16, true);
  if (count === 65535 || size === 0xffffffff || offset === 0xffffffff) {
    const endPosition = file.size - tail.length + end;
    const locatorBytes = await read(file, endPosition - 20, 20);
    const locator = new DataView(locatorBytes.buffer);
    if (signature(locator, 0) !== 0x07064b50 || signature(locator, 4) !== 0 || signature(locator, 16) !== 1) throw new Error('Invalid ZIP64 directory.');
    const zip64Bytes = await read(file, safe64(locator, 8), 56);
    const zip64 = new DataView(zip64Bytes.buffer);
    if (signature(zip64, 0) !== 0x06064b50 || signature(zip64, 16) || signature(zip64, 20)) throw new Error('Invalid ZIP64 directory.');
    count = safe64(zip64, 32); size = safe64(zip64, 40); offset = safe64(zip64, 48);
  }
  if (size > 16 * 1024 * 1024 || count > 200_000) throw new Error('ZIP directory is too large. Export fewer files or select export.xml.');
  const bytes = await read(file, offset, size);
  const directory = new DataView(bytes.buffer);
  const entries: ZipEntry[] = [];
  let position = 0;
  for (let index = 0; index < count; index++) {
    if (position + 46 > size || signature(directory, position) !== 0x02014b50) throw new Error('Invalid ZIP directory entry.');
    const flags = directory.getUint16(position + 8, true);
    const compression = directory.getUint16(position + 10, true);
    const crc = signature(directory, position + 16);
    let compressedSize = signature(directory, position + 20);
    let originalSize = signature(directory, position + 24);
    const nameLength = directory.getUint16(position + 28, true);
    const extraLength = directory.getUint16(position + 30, true);
    const commentLength = directory.getUint16(position + 32, true);
    if (directory.getUint16(position + 34, true)) throw new Error('Split ZIP archives are not supported.');
    let entryOffset = signature(directory, position + 42);
    const next = position + 46 + nameLength + extraLength + commentLength;
    if (next > size) throw new Error('ZIP directory entry is incomplete.');
    // Relevant export basenames are ASCII. Decode UTF-8 names for readable provenance.
    const name = new TextDecoder().decode(bytes.subarray(position + 46, position + 46 + nameLength));
    const extraEnd = position + 46 + nameLength + extraLength;
    for (let extra = position + 46 + nameLength; extra + 4 <= extraEnd;) {
      const type = directory.getUint16(extra, true);
      const length = directory.getUint16(extra + 2, true);
      if (extra + 4 + length > extraEnd) throw new Error('Invalid ZIP extra field.');
      if (type === 1) {
        let valueOffset = extra + 4;
        const take = () => {
          if (valueOffset + 8 > extra + 4 + length) throw new Error('ZIP64 sizes are incomplete.');
          const result = safe64(directory, valueOffset); valueOffset += 8; return result;
        };
        if (originalSize === 0xffffffff) originalSize = take();
        if (compressedSize === 0xffffffff) compressedSize = take();
        if (entryOffset === 0xffffffff) entryOffset = take();
      }
      extra += 4 + length;
    }
    if ([compressedSize, originalSize, entryOffset].includes(0xffffffff)) throw new Error('ZIP64 sizes are missing.');
    entries.push({ name, flags, compression, crc, compressedSize, originalSize, offset: entryOffset });
    position = next;
  }
  return entries;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export async function consumeZipEntry(file: Blob, entry: ZipEntry,
  consume: (data: Uint8Array, final: boolean) => void, isCancelled: () => boolean = () => false
): Promise<void> {
  if (entry.flags & 1) throw new Error('Encrypted ZIP exports are not supported.');
  if (![0, 8].includes(entry.compression)) throw new Error('Unsupported ZIP compression method.');
  const local = await read(file, entry.offset, 30);
  const header = new DataView(local.buffer);
  if (signature(header, 0) !== 0x04034b50 || header.getUint16(8, true) !== entry.compression) throw new Error('Invalid ZIP file header.');
  const dataOffset = entry.offset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
  if (dataOffset + entry.compressedSize > file.size) throw new Error('ZIP entry is truncated.');
  let crc = 0xffffffff;
  let outputSize = 0;
  const output = (bytes: Uint8Array, final: boolean) => {
    outputSize += bytes.length;
    if (outputSize > entry.originalSize) throw new Error('ZIP entry exceeds its declared size.');
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    consume(bytes, final);
    if (final && (outputSize !== entry.originalSize || ((crc ^ 0xffffffff) >>> 0) !== entry.crc)) throw new Error('ZIP entry failed its size or checksum check.');
  };
  const inflater = entry.compression === 8 ? new Inflate(output) : undefined;
  if (!entry.compressedSize) { output(new Uint8Array(), true); return; }
  for (let offset = 0; offset < entry.compressedSize; offset += 64 * 1024) {
    if (isCancelled()) throw new Error('Processing cancelled.');
    const bytes = await read(file, dataOffset + offset, Math.min(64 * 1024, entry.compressedSize - offset));
    const final = offset + bytes.length === entry.compressedSize;
    if (inflater) inflater.push(bytes, final); else output(bytes, final);
  }
}
