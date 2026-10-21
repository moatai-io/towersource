/**
 * Additional finance tools for Pi engine.
 *
 * Tools:
 *   - pdf_read:    Extract tables from PDF files (financial reports, invoices, prospectuses)
 *   - excel_write: Write DataFrame to formatted Excel with auto-width, number formats, bold headers
 *   - excel_diff:  Compare multiple Excel/CSV files side-by-side with automatic column matching
 */

import { Type } from '@sinclair/typebox';
import { assertSessionAllowsSharedArtifactWrite } from '../services/session/session-artifact-privacy.js';
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import path from 'path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { SMART_READER_PY, type ExcelToolContext, prepareFinanceInput, resolveExcelInputPath } from './pi-finance-tools.js';
import { requireDetectedMime, withPreparedLocalFile, type PreparedFileRepresentation } from '../services/content-safety/file-representation-gateway.js';
import { applyModelOutputBudget } from '../services/content-safety/model-output-budget-gateway.js';

type FinanceExtraToolContext = ExcelToolContext;

async function withFinanceInputFiles<T>(files: PreparedFileRepresentation[], use: (paths: string[]) => Promise<T>, paths: string[] = []): Promise<T> {
  if (!files.length) return use(paths);
  return withPreparedLocalFile(files[0], undefined, 100 * 1024 * 1024,
    local => withFinanceInputFiles(files.slice(1), use, [...paths, local]));
}

function makePythonTempDir(ctx: FinanceExtraToolContext): string {
  const sessionPart = (ctx.sessionId || 'sessionless')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 36) || 'sessionless';
  return fs.mkdtempSync(path.join(os.tmpdir(), `tower-finance-extra-${sessionPart}-${crypto.randomUUID().slice(0, 8)}-`));
}

/** Run a Python script via a per-call temp file (avoids shell escaping and multi-user filename collisions). */
function runPython(script: string, opts: { tempDir: string; timeout?: number }): string {
  const tmpScript = path.join(opts.tempDir, 'tower_py_run.py');
  fs.writeFileSync(tmpScript, script, 'utf-8');
  return execFileSync('python3', [tmpScript], {
    timeout: opts.timeout || 30000,
    maxBuffer: 10 * 1024 * 1024,
    encoding: 'utf-8',
  });
}

function ensureSmartReaderScript(tempDir: string): string {
  const moduleDir = path.join(tempDir, 'excel-reader');
  fs.mkdirSync(moduleDir, { recursive: true });
  fs.writeFileSync(path.join(moduleDir, 'tower_excel_reader.py'), SMART_READER_PY, 'utf-8');
  return moduleDir;
}

function withFinancePythonEnv<T>(ctx: FinanceExtraToolContext, fn: (env: { tempDir: string; readerDir: string }) => T): T {
  const tempDir = makePythonTempDir(ctx);
  try {
    return fn({ tempDir, readerDir: ensureSmartReaderScript(tempDir) });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════
// pdf_read — Extract tables from PDF
// ═══════════════════════════════════════════════════════════════

const PdfReadParams = Type.Object({
  path: Type.String({ description: 'Path to the PDF file' }),
  pages: Type.Optional(Type.String({ description: 'Page range: "1", "1-3", "1,3,5". Defaults to all pages (max 20).' })),
  table_index: Type.Optional(Type.Number({ description: 'Extract only this table (0-indexed). Defaults to all tables.' })),
});

export function createPdfReadTool(ctx: FinanceExtraToolContext): ToolDefinition {
  return {
    name: 'pdf_read',
    label: 'Read PDF Tables',
    description: [
      'Extract tables from PDF files. Handles:',
      '- Financial reports, invoices, prospectuses, audit reports',
      '- Korean parenthetical negatives like (1,234,567) → -1234567',
      '- Multi-page table continuation',
      'Returns structured data per table with column names auto-detected.',
    ].join('\n'),
    promptSnippet: 'Extract tables from PDF files (financial reports, invoices, audit reports).',
    promptGuidelines: [
      'Use pdf_read to extract tables from PDF documents; use pdf_view for visual/layout understanding.',
      'Specify pages to limit scope when possible.',
      'Korean financial PDFs often use parenthetical negatives, which are auto-converted.',
      'For detailed PDF table extraction and pdf_view/pdf_read selection rules, use runtime_guide_read with name="pdf-analysis".',
    ],
    parameters: PdfReadParams,

    async execute(_id: string, params: { path: string; pages?: string; table_index?: number }) {
      const { path: rawFilePath, pages, table_index } = params;

      try {
        const prepared = requireDetectedMime(await prepareFinanceInput(rawFilePath, ctx), ['application/pdf'], 'pdf_read');
        return await withPreparedLocalFile(prepared, undefined, 100 * 1024 * 1024, async filePath => {
        const result = withFinancePythonEnv(ctx, ({ tempDir }) => {
          const pyScript = `
import pdfplumber, json, sys, os, re, warnings
warnings.filterwarnings("ignore")

path = ${JSON.stringify(filePath)}
if not os.path.exists(path):
    print(json.dumps({"error": f"File not found: {path}"}))
    sys.exit(0)

page_spec = ${pages ? JSON.stringify(pages) : 'None'}
table_idx = ${table_index !== undefined ? table_index : 'None'}

def parse_pages(spec, total):
    if not spec: return list(range(min(total, 20)))
    pages = set()
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-", 1)
            pages.update(range(int(a)-1, min(int(b), total)))
        else:
            p = int(part) - 1
            if 0 <= p < total: pages.add(p)
    return sorted(pages)

def clean_number(val):
    if not isinstance(val, str): return val
    v = val.strip()
    m = re.match(r'^\\(([\\d,]+)\\)$', v)
    if m:
        return -float(m.group(1).replace(",", ""))
    if re.match(r'^-?[\\d,]+\\.?\\d*$', v.replace(",", "")):
        try: return float(v.replace(",", ""))
        except: pass
    return val

try:
    with pdfplumber.open(path) as pdf:
        total_pages = len(pdf.pages)
        page_indices = parse_pages(page_spec, total_pages)

        all_tables = []
        for pi in page_indices:
            page = pdf.pages[pi]
            tables = page.extract_tables()
            for ti, table in enumerate(tables):
                if not table or not table[0]: continue
                all_tables.append({
                    "page": pi + 1,
                    "table_index": ti,
                    "headers": table[0],
                    "rows": [[clean_number(c) for c in row] for row in table[1:]],
                    "row_count": len(table) - 1,
                })

        if table_idx is not None:
            all_tables = [t for t in all_tables if t["table_index"] == table_idx]

        result = {
            "file": os.path.basename(path),
            "total_pages": total_pages,
            "pages_scanned": len(page_indices),
            "tables_found": len(all_tables),
            "tables": all_tables[:20],
        }
        print(json.dumps(result, ensure_ascii=False, default=str))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`.trim();
          return runPython(pyScript, { tempDir, timeout: 60000 });
        });
        const parsed = JSON.parse(result);
        if (parsed.error) {
          return { content: [{ type: 'text' as const, text: `Error: ${parsed.error}` }], details: undefined };
        }

        const { file, total_pages, pages_scanned, tables_found, tables } = parsed;
        const lines = [
          `**${file}** — ${total_pages} pages, scanned ${pages_scanned}, found ${tables_found} tables`,
          '',
        ];

        for (const t of tables) {
          lines.push(`### Page ${t.page}, Table ${t.table_index + 1} (${t.row_count} rows)`);
          lines.push('Headers: ' + t.headers.join(' | '));
          lines.push('```json');
          const data = t.rows.map((row: any[]) => {
            const obj: Record<string, any> = {};
            t.headers.forEach((h: string, i: number) => { obj[h || `col_${i}`] = row[i]; });
            return obj;
          });
          lines.push(JSON.stringify(data.slice(0, 50), null, 2).slice(0, 4000));
          lines.push('```');
          if (t.row_count > 50) lines.push(`(showing 50 of ${t.row_count} rows)`);
          lines.push('');
        }

        const budgeted = applyModelOutputBudget([{ type: 'text' as const, text: lines.join('\n') }]);
        return { content: budgeted.content, details: { outputBudget: budgeted } };
        });
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `pdf_read failed: ${err.message}` }], details: undefined };
      }
    },
  } as ToolDefinition;
}

export const pdfReadTool: ToolDefinition = createPdfReadTool({ cwd: process.cwd() });

// ═══════════════════════════════════════════════════════════════
// excel_write — Write data to formatted Excel
// ═══════════════════════════════════════════════════════════════

const ExcelWriteParams = Type.Object({
  path: Type.String({ description: 'Output path for the Excel file (.xlsx)' }),
  data: Type.Array(Type.Record(Type.String(), Type.Any()), { description: 'Array of row objects [{col: val, ...}, ...]' }),
  sheet: Type.Optional(Type.String({ description: 'Sheet name. Defaults to "Sheet1".' })),
  number_format: Type.Optional(Type.String({ description: 'Number format for numeric columns (e.g. "#,##0", "#,##0.00", "0.00%"). Defaults to "#,##0".' })),
  title: Type.Optional(Type.String({ description: 'Title row above the data (bold, merged across columns).' })),
});

export function createExcelWriteTool(ctx: FinanceExtraToolContext): ToolDefinition {
  return {
    name: 'excel_write',
    label: 'Write Excel',
    description: [
      'Write structured data to a formatted Excel file. Features:',
      '- Bold header row with filters',
      '- Auto-adjusted column widths',
      '- Number formatting (comma-separated by default)',
      '- Optional title row',
      '- Freeze panes on header row',
      'Output is a proper .xlsx ready to share.',
    ].join('\n'),
    promptSnippet: 'Write data to formatted Excel with bold headers, auto-width, and number formatting.',
    promptGuidelines: [
      'Use excel_write to export analysis results as formatted Excel files.',
      'Pass data as an array of objects; number columns are formatted with commas by default.',
      'For detailed spreadsheet read/query/diff/write workflow rules, use runtime_guide_read with name="spreadsheet-analysis".',
    ],
    parameters: ExcelWriteParams,

    async execute(_id: string, params: { path: string; data: Record<string, any>[]; sheet?: string; number_format?: string; title?: string }) {
      const { path: rawFilePath, data, sheet = 'Sheet1', number_format = '#,##0', title } = params;

      try {
        await assertSessionAllowsSharedArtifactWrite(ctx.sessionId);
        const result = withFinancePythonEnv(ctx, ({ tempDir }) => {
          const filePath = resolveExcelInputPath(rawFilePath, ctx);
          const pyScript = `
import json, os
from openpyxl import Workbook
from openpyxl.styles import Font, Alignment, PatternFill, Border, Side, numbers
from openpyxl.utils import get_column_letter

data = json.loads(${JSON.stringify(JSON.stringify(data))})
if not data:
    print(json.dumps({"error": "No data provided"}))
    exit()

wb = Workbook()
ws = wb.active
ws.title = ${JSON.stringify(sheet)}

columns = list(data[0].keys())
start_row = 1

title = ${title ? JSON.stringify(title) : 'None'}
if title:
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=len(columns))
    cell = ws.cell(1, 1, title)
    cell.font = Font(bold=True, size=14)
    cell.alignment = Alignment(horizontal='center')
    start_row = 3

header_fill = PatternFill(start_color='D9E1F2', end_color='D9E1F2', fill_type='solid')
header_font = Font(bold=True)
thin_border = Border(bottom=Side(style='thin'))
for ci, col in enumerate(columns, 1):
    cell = ws.cell(start_row, ci, col)
    cell.font = header_font
    cell.fill = header_fill
    cell.border = thin_border
    cell.alignment = Alignment(horizontal='center')

num_fmt = ${JSON.stringify(number_format)}
for ri, row in enumerate(data, start_row + 1):
    for ci, col in enumerate(columns, 1):
        val = row.get(col)
        cell = ws.cell(ri, ci, val)
        if isinstance(val, (int, float)) and val == val:
            cell.number_format = num_fmt

for ci, col in enumerate(columns, 1):
    max_len = len(str(col))
    for ri in range(start_row + 1, start_row + 1 + len(data)):
        val = ws.cell(ri, ci).value
        if val is not None:
            vlen = sum(2 if ord(c) > 0x2E80 else 1 for c in str(val))
            max_len = max(max_len, vlen)
    ws.column_dimensions[get_column_letter(ci)].width = min(max_len + 3, 50)

ws.freeze_panes = ws.cell(start_row + 1, 1)
ws.auto_filter.ref = f"A{start_row}:{get_column_letter(len(columns))}{start_row + len(data)}"

path = ${JSON.stringify(filePath)}
os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
wb.save(path)
print(json.dumps({"file": os.path.basename(path), "path": os.path.abspath(path),
    "rows": len(data), "columns": len(columns), "sheet": ws.title}))
`.trim();
          return runPython(pyScript, { tempDir });
        });
        const parsed = JSON.parse(result);
        if (parsed.error) {
          return { content: [{ type: 'text' as const, text: `Error: ${parsed.error}` }], details: undefined };
        }
        return {
          content: [{ type: 'text' as const, text: `Excel written: **${parsed.file}** — ${parsed.rows} rows × ${parsed.columns} columns, sheet "${parsed.sheet}"\nPath: ${parsed.path}` }],
          details: undefined,
        };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `excel_write failed: ${err.message}` }], details: undefined, isError: true };
      }
    },
  } as ToolDefinition;
}

export const excelWriteTool: ToolDefinition = createExcelWriteTool({ cwd: process.cwd() });

// ═══════════════════════════════════════════════════════════════
// excel_diff — Compare multiple spreadsheets
// ═══════════════════════════════════════════════════════════════

const ExcelDiffParams = Type.Object({
  files: Type.Array(Type.String(), { description: 'List of file paths to compare (2 or more Excel/CSV files)' }),
  key_column: Type.Optional(Type.String({ description: 'Column name to match rows across files (e.g. "항목", "거래처"). If omitted, matches by row index.' })),
  value_columns: Type.Optional(Type.Array(Type.String(), { description: 'Columns to compare. If omitted, compares all numeric columns.' })),
  sheet: Type.Optional(Type.String({ description: 'Sheet name (applied to all files).' })),
});

export function createExcelDiffTool(ctx: FinanceExtraToolContext): ToolDefinition {
  return {
    name: 'excel_diff',
    label: 'Compare Excel Files',
    description: [
      'Compare 2+ Excel/CSV files side-by-side. Features:',
      '- Auto-matches columns by name across files',
      '- Computes differences (absolute and percentage) between numeric columns',
      '- Highlights rows with significant changes',
      '- Supports key-column matching (e.g. match by "항목" or "거래처")',
      'Great for period-over-period financial comparisons (e.g. 2024 vs 2025 P&L).',
    ].join('\n'),
    promptSnippet: 'Compare multiple Excel/CSV files with automatic column matching and difference calculation.',
    promptGuidelines: [
      'Use excel_diff to compare financial statements or structured spreadsheets across periods or versions.',
      'Specify key_column when rows have stable labels such as 항목 or 거래처.',
      'For detailed spreadsheet comparison workflow rules, use runtime_guide_read with name="spreadsheet-analysis".',
    ],
    parameters: ExcelDiffParams,

    async execute(_id: string, params: { files: string[]; key_column?: string; value_columns?: string[]; sheet?: string }) {
      const { files, key_column, value_columns, sheet } = params;

      if (files.length < 2) {
        return { content: [{ type: 'text' as const, text: 'Need at least 2 files to compare.' }], details: undefined };
      }

      const sheetArg = sheet ? JSON.stringify(sheet) : 'None';
      const keyCol = key_column ? JSON.stringify(key_column) : 'None';
      const valCols = value_columns ? JSON.stringify(value_columns) : 'None';

      try {
        const preparedFiles = await Promise.all(files.map(file => prepareFinanceInput(file, ctx)));
        return await withFinanceInputFiles(preparedFiles, async resolvedFiles => {
        const result = withFinancePythonEnv(ctx, ({ tempDir, readerDir }) => {
          const pyScript = `
import pandas as pd, json, sys, os, numpy as np
sys.path.insert(0, ${JSON.stringify(readerDir)})
from tower_excel_reader import smart_read

files = json.loads(${JSON.stringify(JSON.stringify(resolvedFiles))})
key_col = ${keyCol}
val_cols = ${valCols}
sheet = ${sheetArg}

def load(path):
    df, meta = smart_read(path, sheet_name=sheet, max_rows=10000)
    if '_style' in df.columns: df = df.drop(columns=['_style'])
    return df, os.path.basename(path)

try:
    dfs = []
    names = []
    for f in files:
        df, name = load(f)
        dfs.append(df)
        names.append(name)

    if val_cols:
        compare_cols = val_cols
    else:
        common = set(dfs[0].columns)
        for df in dfs[1:]:
            common &= set(df.columns)
        compare_cols = [c for c in common if dfs[0][c].dtype in ['float64','int64','float32','int32'] or pd.to_numeric(dfs[0][c], errors='coerce').notna().any()]

    if key_col:
        for i in range(len(dfs)):
            if key_col in dfs[i].columns:
                dfs[i] = dfs[i].set_index(key_col)

    results = []
    base_df = dfs[0]
    base_name = names[0]

    for i in range(1, len(dfs)):
        comp_df = dfs[i]
        comp_name = names[i]

        rows = []
        if key_col:
            all_keys = list(dict.fromkeys(list(base_df.index) + list(comp_df.index)))
        else:
            all_keys = range(max(len(base_df), len(comp_df)))

        for key in all_keys:
            row = {"_key": str(key) if key_col else int(key)}
            for col in compare_cols:
                try:
                    v1 = base_df.loc[key, col] if key in base_df.index else None
                    v2 = comp_df.loc[key, col] if key in comp_df.index else None
                except: continue

                try: v1 = float(v1) if v1 is not None and pd.notna(v1) else None
                except: v1 = None
                try: v2 = float(v2) if v2 is not None and pd.notna(v2) else None
                except: v2 = None

                row[f"{col}__{base_name}"] = v1
                row[f"{col}__{comp_name}"] = v2

                if v1 is not None and v2 is not None:
                    delta = v2 - v1
                    row[f"{col}__delta"] = delta
                    row[f"{col}__pct"] = f"{(delta/v1*100):.1f}%" if v1 != 0 else "N/A"
                else:
                    row[f"{col}__delta"] = None
                    row[f"{col}__pct"] = None

            rows.append(row)

        results.append({
            "comparison": f"{base_name} vs {comp_name}",
            "key_column": key_col,
            "compared_columns": compare_cols,
            "rows": rows[:200],
            "total_rows": len(rows),
            "significant_changes": len([r for r in rows if any(
                abs(r.get(f"{c}__delta", 0) or 0) > 0 for c in compare_cols
            )]),
        })

    output = {
        "files": names,
        "comparisons": results,
    }
    print(json.dumps(output, ensure_ascii=False, default=str))

except Exception as e:
    print(json.dumps({"error": str(e)}))
`.trim();
          return runPython(pyScript, { tempDir, timeout: 60000 });
        });
        const parsed = JSON.parse(result);
        if (parsed.error) {
          return { content: [{ type: 'text' as const, text: `Error: ${parsed.error}` }], details: undefined };
        }

        const lines = [`**Comparing ${parsed.files.length} files:** ${parsed.files.join(' vs ')}`, ''];

        for (const comp of parsed.comparisons) {
          lines.push(`### ${comp.comparison}`);
          lines.push(`Key: ${comp.key_column || '(row index)'} | Columns compared: ${comp.compared_columns.join(', ')}`);
          lines.push(`Rows with changes: ${comp.significant_changes} / ${comp.total_rows}`);
          lines.push('');
          lines.push('```json');
          lines.push(JSON.stringify(comp.rows.slice(0, 30), null, 2).slice(0, 6000));
          lines.push('```');
          if (comp.total_rows > 30) lines.push(`(showing 30 of ${comp.total_rows} rows)`);
          lines.push('');
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }], details: undefined };
        });
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `excel_diff failed: ${err.message}` }], details: undefined };
      }
    },
  } as ToolDefinition;
}

export const excelDiffTool: ToolDefinition = createExcelDiffTool({ cwd: process.cwd() });
