import path from 'path';
import { describe, expect, it } from 'vitest';
import { createExcelDiffTool, createExcelWriteTool, createPdfReadTool } from '../pi-finance-tools-extra.js';

describe('Pi finance extra tools — context-aware factories', () => {
  it('builds pdf_read, excel_write, and excel_diff through context-aware factories', () => {
    const ctx = {
      cwd: '/home/tower/workspace/projects/tower',
      projectRoot: '/home/tower/workspace/projects/tower',
      sessionId: 'session-extra',
    };

    const pdfTool = createPdfReadTool(ctx);
    const writeTool = createExcelWriteTool(ctx);
    const diffTool = createExcelDiffTool(ctx);

    expect(pdfTool.name).toBe('pdf_read');
    expect(writeTool.name).toBe('excel_write');
    expect(diffTool.name).toBe('excel_diff');
    expect(pdfTool.execute).toEqual(expect.any(Function));
    expect(writeTool.execute).toEqual(expect.any(Function));
    expect(diffTool.execute).toEqual(expect.any(Function));
  });

  it('keeps Python helper scripts and smart reader modules out of shared /tmp singleton names', async () => {
    const financeExtraSource = await import('node:fs/promises').then(fs => fs.readFile(
      path.resolve(import.meta.dirname, '../pi-finance-tools-extra.ts'),
      'utf-8',
    ));

    expect(financeExtraSource).toContain('fs.mkdtempSync');
    expect(financeExtraSource).toContain('crypto.randomUUID');
    expect(financeExtraSource).toContain('resolveExcelInputPath');
    expect(financeExtraSource).toContain('SMART_READER_PY');
    expect(financeExtraSource).not.toContain("require('fs')");
    expect(financeExtraSource).not.toContain("'/tmp/tower_py_run.py'");
    expect(financeExtraSource).not.toContain("'/tmp/tower_excel_reader.py'");
    expect(financeExtraSource).not.toContain("sys.path.insert(0, '/tmp')");
    expect(financeExtraSource).not.toContain('execSync(`python3');
  });
});
