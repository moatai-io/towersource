import type { CellObject, ColInfo, Range, RowInfo, WorkSheet } from 'xlsx';
import * as XLSX from 'xlsx';

const DEFAULT_COL_WIDTH_PX = 64;
const DEFAULT_ROW_HEIGHT_PX = 22;
const MAX_FRACTION_DIGITS = 10;
const MAX_PREVIEW_SHEETS = 8;
const MAX_PREVIEW_ROWS = 1000;
const MAX_PREVIEW_COLS = 200;

export type PreviewCol = {
  key: string;
  widthPx: number;
  hidden: boolean;
};

export type PreviewCell = {
  key: string;
  text: string;
  style: Record<string, string | number>;
  className: string;
  colSpan?: number;
  rowSpan?: number;
  href?: string;
  title?: string;
};

export type PreviewRow = {
  key: string;
  heightPx: number;
  hidden: boolean;
  cells: PreviewCell[];
};

export type SheetPreview = {
  cols: PreviewCol[];
  rows: PreviewRow[];
  empty: boolean;
  truncated?: boolean;
};

type WorkerRequest = {
  id: number;
  buffer: ArrayBuffer;
};

type WorkerResponse =
  | {
      id: number;
      ok: true;
      sheetNames: string[];
      activeSheet: string;
      sheets: Record<string, SheetPreview>;
      truncated: boolean;
    }
  | {
      id: number;
      ok: false;
      error: string;
    };

function clampPx(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function getColumnWidthPx(col?: ColInfo): number {
  if (!col) return DEFAULT_COL_WIDTH_PX;
  if (typeof col.wpx === 'number') return clampPx(col.wpx, 12, 600);
  if (typeof col.wch === 'number') return clampPx(col.wch * 7 + 5, 12, 600);
  if (typeof col.width === 'number') return clampPx(col.width * 7 + 5, 12, 600);
  return DEFAULT_COL_WIDTH_PX;
}

function getRowHeightPx(row?: RowInfo): number {
  if (!row) return DEFAULT_ROW_HEIGHT_PX;
  if (typeof row.hpx === 'number') return clampPx(row.hpx, 8, 400);
  if (typeof row.hpt === 'number') return clampPx(row.hpt * 96 / 72, 8, 400);
  return DEFAULT_ROW_HEIGHT_PX;
}

function normalizeRgb(rgb?: string): string | undefined {
  if (!rgb) return undefined;
  const hex = rgb.trim().replace(/^#/, '').slice(-6);
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return undefined;
  return `#${hex.toUpperCase()}`;
}

function isGeneralNumberFormat(cell: CellObject): boolean {
  const fmt = typeof cell.z === 'string' ? cell.z.trim().toLowerCase() : '';
  return !fmt || fmt === 'general';
}

function formatPlainNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return new Intl.NumberFormat('ko-KR', {
    maximumFractionDigits: MAX_FRACTION_DIGITS,
  }).format(value);
}

function getCellText(cell?: CellObject): string {
  if (!cell) return '';

  const formatted = XLSX.utils.format_cell(cell);
  if (cell.t === 'n' && typeof cell.v === 'number' && isGeneralNumberFormat(cell)) {
    return formatPlainNumber(cell.v);
  }

  if (formatted != null && formatted !== '') return formatted;
  if (cell.t === 'd' && cell.v instanceof Date) return cell.v.toLocaleDateString('ko-KR');
  if (cell.t === 'b') return cell.v ? 'TRUE' : 'FALSE';
  if (cell.v == null) return '';
  return String(cell.v);
}

function getSafeHref(target?: string): string | undefined {
  if (!target) return undefined;
  if (/^(https?:|mailto:|#)/i.test(target)) return target;
  return undefined;
}

function getCellTitle(cell?: CellObject): string | undefined {
  if (!cell) return undefined;
  const notes: string[] = [];
  if (cell.f) notes.push(`=${cell.f}`);
  if (cell.c?.length) {
    const comment = cell.c.map((c) => c.t).filter(Boolean).join('\n');
    if (comment) notes.push(comment);
  }
  if (cell.l?.Tooltip) notes.push(cell.l.Tooltip);
  return notes.length ? notes.join('\n\n') : undefined;
}

function getCellStyle(cell?: CellObject): Record<string, string | number> {
  const style: Record<string, string | number> = {};
  const rawStyle = cell?.s as any;
  if (!rawStyle) return style;

  const patternType = rawStyle.patternType;
  const fillRgb = normalizeRgb(rawStyle.fgColor?.rgb || rawStyle.bgColor?.rgb);
  if (fillRgb && patternType !== 'none' && patternType !== 'gray125') style.backgroundColor = fillRgb;

  const font = rawStyle.font || rawStyle.Font;
  const fontColor = normalizeRgb(font?.color?.rgb || font?.Color?.rgb);
  if (fontColor) style.color = fontColor;
  if (font?.bold || font?.b) style.fontWeight = 700;
  if (font?.italic || font?.i) style.fontStyle = 'italic';
  if (font?.underline || font?.u) style.textDecoration = 'underline';

  const alignment = rawStyle.alignment || rawStyle.Alignment;
  if (alignment?.horizontal) style.textAlign = alignment.horizontal;
  if (alignment?.vertical) style.verticalAlign = alignment.vertical;
  if (alignment?.wrapText || alignment?.wrap) style.whiteSpace = 'pre-wrap';

  return style;
}

function buildMergeMaps(merges: Range[] = [], maxRow: number, maxCol: number) {
  const starts = new Map<string, Range>();
  const covered = new Set<string>();

  for (const merge of merges) {
    if (merge.s.r > maxRow || merge.s.c > maxCol) continue;
    const clipped: Range = {
      s: merge.s,
      e: { r: Math.min(merge.e.r, maxRow), c: Math.min(merge.e.c, maxCol) },
    };
    const startKey = `${clipped.s.r}:${clipped.s.c}`;
    starts.set(startKey, clipped);

    for (let r = clipped.s.r; r <= clipped.e.r; r += 1) {
      for (let c = clipped.s.c; c <= clipped.e.c; c += 1) {
        const key = `${r}:${c}`;
        if (key !== startKey) covered.add(key);
      }
    }
  }

  return { starts, covered };
}

function buildSheetPreview(sheet: WorkSheet): SheetPreview {
  const ref = sheet['!ref'];
  if (!ref) return { cols: [], rows: [], empty: true };

  const range = XLSX.utils.decode_range(ref);
  const maxRow = Math.min(range.e.r, range.s.r + MAX_PREVIEW_ROWS - 1);
  const maxCol = Math.min(range.e.c, range.s.c + MAX_PREVIEW_COLS - 1);
  const truncated = maxRow < range.e.r || maxCol < range.e.c;
  const sheetCols = sheet['!cols'] || [];
  const sheetRows = sheet['!rows'] || [];
  const { starts: mergeStarts, covered: mergeCovered } = buildMergeMaps(sheet['!merges'], maxRow, maxCol);

  const cols: PreviewCol[] = [];
  for (let c = range.s.c; c <= maxCol; c += 1) {
    const col = sheetCols[c];
    cols.push({
      key: `col-${c}`,
      widthPx: getColumnWidthPx(col),
      hidden: !!col?.hidden,
    });
  }

  const rows: PreviewRow[] = [];
  for (let r = range.s.r; r <= maxRow; r += 1) {
    const rowInfo = sheetRows[r];
    const cells: PreviewCell[] = [];

    for (let c = range.s.c; c <= maxCol; c += 1) {
      const mergeKey = `${r}:${c}`;
      if (mergeCovered.has(mergeKey)) continue;

      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[addr] as CellObject | undefined;
      const merge = mergeStarts.get(mergeKey);
      const text = getCellText(cell);
      const href = getSafeHref(cell?.l?.Target);
      const classes = ['xlsx-cell'];

      if (cell?.t === 'n') classes.push('xlsx-cell-number');
      if (cell?.t === 'd') classes.push('xlsx-cell-date');
      if (!text) classes.push('xlsx-cell-empty');
      if (href) classes.push('xlsx-cell-link');

      cells.push({
        key: addr,
        text,
        style: getCellStyle(cell),
        className: classes.join(' '),
        colSpan: merge ? merge.e.c - merge.s.c + 1 : undefined,
        rowSpan: merge ? merge.e.r - merge.s.r + 1 : undefined,
        href,
        title: getCellTitle(cell),
      });
    }

    rows.push({
      key: `row-${r}`,
      heightPx: getRowHeightPx(rowInfo),
      hidden: !!rowInfo?.hidden,
      cells,
    });
  }

  return { cols, rows, empty: rows.length === 0 || cols.length === 0, truncated };
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { id, buffer } = event.data;
  try {
    const workbook = XLSX.read(new Uint8Array(buffer), {
      type: 'array',
      codepage: 65001,
      cellDates: true,
      cellNF: true,
      cellStyles: true,
      cellText: true,
      sheetRows: MAX_PREVIEW_ROWS,
    });

    const allNames = workbook.SheetNames;
    const names = allNames.slice(0, MAX_PREVIEW_SHEETS);
    const previewMap: Record<string, SheetPreview> = {};
    let truncated = names.length < allNames.length;
    for (const name of names) {
      const sheet = workbook.Sheets[name];
      previewMap[name] = buildSheetPreview(sheet);
      truncated = truncated || !!previewMap[name].truncated;
    }

    const response: WorkerResponse = {
      id,
      ok: true,
      sheetNames: names,
      activeSheet: names[0] || '',
      sheets: previewMap,
      truncated,
    };
    self.postMessage(response);
  } catch (err: any) {
    const response: WorkerResponse = { id, ok: false, error: err?.message || 'Failed to render spreadsheet' };
    self.postMessage(response);
  }
};
