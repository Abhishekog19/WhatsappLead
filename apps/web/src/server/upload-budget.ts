import { inflateRawSync } from 'node:zlib';

// Check actual inflated bytes before ExcelJS materialises a workbook. ZIP
// metadata alone is untrusted; maxOutputLength also bounds forged size headers.
export function checkWorkbookBudget(bytes: Buffer, maxRows: number): void {
  const fail = () => { throw new Error('Workbook is too large or complex. Export one sheet as CSV.'); };
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0) return fail();
  const entries = bytes.readUInt16LE(end + 10);
  if (entries > 128 || bytes.readUInt16LE(end + 4) !== 0) return fail();
  let cursor = bytes.readUInt32LE(end + 16);
  let remaining = 8 * 1024 * 1024;
  let cells = 0;
  for (let i = 0; i < entries; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) return fail();
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const size = bytes.readUInt32LE(cursor + 20);
    const inflatedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const local = bytes.readUInt32LE(cursor + 42);
    if ((flags & 1) || inflatedSize > remaining || local + 30 > cursor) return fail();
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString();
    if (bytes.readUInt32LE(local) !== 0x04034b50) return fail();
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (start + size > cursor || remaining < 1) return fail();
    const compressed = bytes.subarray(start, start + size);
    const data = method === 0 ? compressed : method === 8
      ? inflateRawSync(compressed, { maxOutputLength: remaining }) : fail();
    if (data.length !== inflatedSize || data.length > remaining) return fail();
    remaining -= data.length;
    if (name.endsWith('.xml')) {
      const xml = data.toString('utf8');
      if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return fail();
      let rowCount = 0;
      for (const row of xml.matchAll(/<row\b[^>]*\br="(\d+)"/g)) {
        if (++rowCount > maxRows + 1 || Number(row[1]) > maxRows + 1) return fail();
      }
      if ((xml.match(/<si\b/g)?.length ?? 0) > 100_000) return fail();
      for (const match of xml.matchAll(/<c\b[^>]*\br="([A-Z]+)(\d+)"/g)) {
        const col = [...match[1]!].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
        if (++cells > 100_000 || col > 40 || Number(match[2]) > maxRows + 1) return fail();
      }
    }
    cursor += 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
  }
  if (cursor !== end) return fail();
}

export function checkCsvBudget(text: string, maxRows: number): void {
  let quoted = false, rows = 1, columns = 1, length = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') i++;
      else quoted = !quoted;
    }
    if (!quoted && c === ',') { columns++; length = 0; }
    else if (!quoted && c === '\n') { rows++; columns = 1; length = 0; }
    else length++;
    if (rows > maxRows + 2 || columns > 40 || length > 16_384) {
      throw new Error('CSV exceeds the row, 40-column, or cell-length limit. Split the file.');
    }
  }
}
