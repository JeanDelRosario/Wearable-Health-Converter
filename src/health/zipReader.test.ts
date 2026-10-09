import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { consumeZipEntry, readZipDirectory } from './zipReader';

describe('selective ZIP reader', () => {
  it('reads only selected contents and validates checksums', async () => {
    const bytes = zipSync({ 'chosen.csv': strToU8('hello'), 'ignored.txt': new Uint8Array(1_000_000).fill(120) }, { level: 0 });
    const blob = new Blob([bytes]);
    let bytesRead = 0;
    const originalSlice = blob.slice.bind(blob);
    blob.slice = (start, end, type) => { bytesRead += (end ?? blob.size) - (start ?? 0); return originalSlice(start, end, type); };
    const entries = await readZipDirectory(blob);
    let text = '';
    await consumeZipEntry(blob, entries[0], (data) => { text += new TextDecoder().decode(data); });
    expect(text).toBe('hello');
    expect(bytesRead).toBeLessThan(70_000);
    const corrupt = bytes.slice(); corrupt[entries[0].offset + 30 + 'chosen.csv'.length] ^= 1;
    await expect(consumeZipEntry(new Blob([corrupt]), entries[0], () => {})).rejects.toThrow('checksum');
  });

  it('reads a ZIP64 directory without loading file contents', async () => {
    const normal = zipSync({ 'one.txt': strToU8('hello') });
    const end = normal.length - 22;
    const oldEnd = new DataView(normal.buffer, normal.byteOffset + end, 22);
    const zip64 = new Uint8Array(56); const z = new DataView(zip64.buffer);
    z.setUint32(0, 0x06064b50, true); z.setBigUint64(4, 44n, true);
    z.setUint16(12, 45, true); z.setUint16(14, 45, true);
    z.setBigUint64(24, 1n, true); z.setBigUint64(32, 1n, true);
    z.setBigUint64(40, BigInt(oldEnd.getUint32(12, true)), true);
    z.setBigUint64(48, BigInt(oldEnd.getUint32(16, true)), true);
    const locator = new Uint8Array(20); const l = new DataView(locator.buffer);
    l.setUint32(0, 0x07064b50, true); l.setBigUint64(8, BigInt(end), true); l.setUint32(16, 1, true);
    const sentinel = normal.slice(end); const s = new DataView(sentinel.buffer);
    s.setUint16(8, 65535, true); s.setUint16(10, 65535, true);
    s.setUint32(12, 0xffffffff, true); s.setUint32(16, 0xffffffff, true);
    const blob = new Blob([normal.slice(0, end), zip64, locator, sentinel]);
    const entries = await readZipDirectory(blob);
    expect(entries).toHaveLength(1);
    let text = ''; await consumeZipEntry(blob, entries[0], (data) => { text += new TextDecoder().decode(data); });
    expect(text).toBe('hello');
  });

  it('rejects incomplete archives and cancellation', async () => {
    await expect(readZipDirectory(new Blob([strToU8('not a zip')]))).rejects.toThrow('directory');
    const blob = new Blob([zipSync({ 'one.txt': strToU8('hello') })]);
    const entries = await readZipDirectory(blob);
    await expect(consumeZipEntry(blob, entries[0], () => {}, () => true)).rejects.toThrow('cancelled');
  });
});
