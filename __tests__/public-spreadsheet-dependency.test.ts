import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const requireFrontend = createRequire(new URL('../packages/frontend/package.json', import.meta.url));
const XLSX = requireFrontend('xlsx');

// The public build uses SheetJS' official patched distribution rather than
// the unmaintained npm xlsx 0.18 line. Exercise the worker's read/write API.
describe('public spreadsheet dependency', () => {
  it('uses the patched distribution and preserves worksheet values', () => {
    expect(XLSX.version).toBe('0.20.3');
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ['Item', 'Amount'], ['Sample', 1234], ['Text', '=not a formula'],
    ]), 'Example');
    const encoded = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
    const decoded = XLSX.read(encoded, { type: 'array' });
    expect(XLSX.utils.sheet_to_json(decoded.Sheets.Example, { header: 1 })).toEqual([
      ['Item', 'Amount'], ['Sample', 1234], ['Text', '=not a formula'],
    ]);
  });
});
