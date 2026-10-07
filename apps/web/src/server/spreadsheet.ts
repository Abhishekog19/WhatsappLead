import ExcelJS from 'exceljs';
import { MAX_IMPORT_ROWS } from '@wa/core';

/**
 * Spreadsheet decoding.
 *
 * Deliberately separate from the mapping rules in @wa/core: this is the only
 * part that knows about file formats, and it is the only part that touches
 * untrusted bytes. Everything downstream works on plain objects.
 *
 * ExcelJS rather than SheetJS: the npm build of SheetJS has unpatched
 * prototype-pollution and ReDoS advisories, and this parses files uploaded by
 * anyone with an account.
 */

export interface DecodedSheet {
  headers: string[];
  rows: Record<string, unknown>[];
  /** Name of the sheet that was read. */
  sheetName: string;
  /** True when rows were dropped because the file exceeded the row limit. */
  truncated: boolean;
}

export class ImportFileError extends Error {}

export async function decodeSpreadsheet(
  file: File,
): Promise<DecodedSheet> {
  const name = file.name.toLowerCase();
  const buffer = await file.arrayBuffer();

  if (name.endsWith('.csv')) return decodeCsv(buffer);
  if (name.endsWith('.xlsx') || name.endsWith('.xlsm')) return decodeXlsx(buffer);

  throw new ImportFileError(
    'Unsupported file type. Upload a .xlsx or .csv file.',
  );
}

async function decodeXlsx(buffer: ArrayBuffer): Promise<DecodedSheet> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw new ImportFileError(
      'That file could not be read. If it was exported from another tool, try saving it as .csv.',
    );
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) throw new ImportFileError('The file has no sheets.');

  return extract(sheet);
}

async function decodeCsv(buffer: ArrayBuffer): Promise<DecodedSheet> {
  const workbook = new ExcelJS.Workbook();
  try {
    // ExcelJS' CSV reader wants a stream; a one-chunk readable is enough and
    // avoids writing the upload to a temporary file.
    const { Readable } = await import('node:stream');
    const stream = Readable.from([Buffer.from(buffer)]);
    await workbook.csv.read(stream);
  } catch {
    throw new ImportFileError('That CSV could not be read.');
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) throw new ImportFileError('The file appears to be empty.');

  return extract(sheet);
}

function extract(sheet: ExcelJS.Worksheet): DecodedSheet {
  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  const seen = new Map<string, number>();

  headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    let label = cellToString(cell.value).trim();
    if (!label) label = `Column ${colNumber}`;

    // Duplicate headers would silently overwrite each other in the row object,
    // which loses data without telling anyone.
    const count = seen.get(label) ?? 0;
    seen.set(label, count + 1);
    headers[colNumber - 1] = count === 0 ? label : `${label} (${count + 1})`;
  });

  if (headers.filter(Boolean).length === 0) {
    throw new ImportFileError(
      'The first row needs to be column headings, e.g. Name and Phone.',
    );
  }

  const rows: Record<string, unknown>[] = [];
  let truncated = false;

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    if (rows.length >= MAX_IMPORT_ROWS) {
      truncated = true;
      return;
    }

    const obj: Record<string, unknown> = {};
    let hasValue = false;

    headers.forEach((header, index) => {
      if (!header) return;
      const value = cellToString(row.getCell(index + 1).value);
      obj[header] = value;
      if (value.trim()) hasValue = true;
    });

    // Trailing blank rows are extremely common in hand-edited sheets.
    if (hasValue) rows.push(obj);
  });

  return {
    headers: headers.filter(Boolean),
    rows,
    sheetName: sheet.name,
    truncated,
  };
}

/**
 * Flattens ExcelJS cell values to strings.
 *
 * Cells are not plain values: a phone number pasted as a link becomes a
 * hyperlink object, a formula cell carries its computed result separately, and
 * a long number may arrive as a rich-text run. Each of those would stringify
 * to "[object Object]" and take a usable lead with it.
 */
function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);

  if (typeof value === 'object') {
    // Formula cell: the result is what the user sees in Excel.
    if ('result' in value && value.result !== undefined) {
      return cellToString(value.result as ExcelJS.CellValue);
    }
    // Hyperlink cell: the visible text, not the href.
    if ('text' in value && typeof value.text === 'string') return value.text;
    // Rich text: concatenate the runs.
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((r) => r.text ?? '').join('');
    }
    if ('error' in value) return '';
  }

  return String(value);
}
