import path from 'path';
import { describe, expect, it } from 'vitest';
import { createExcelQueryTool, createExcelReadTool, resolveExcelInputPath } from '../pi-finance-tools.js';

describe('Pi finance Excel tools — context-aware path handling', () => {
  it('resolves Runtime Box /workspace paths against the host project root', () => {
    const resolved = resolveExcelInputPath('/workspace/reports/매출.xlsx', {
      cwd: '/home/tower/workspace/projects/tower',
      projectRoot: '/home/tower/workspace/projects/acme',
      sessionId: 's1',
    });

    expect(resolved).toBe('/home/tower/workspace/projects/acme/reports/매출.xlsx');
  });

  it('rejects Runtime Box paths that escape the project root', () => {
    expect(() => resolveExcelInputPath('/workspace/../other/secret.xlsx', {
      cwd: '/home/tower/workspace/projects/tower',
      projectRoot: '/home/tower/workspace/projects/acme',
      sessionId: 's1',
    })).toThrow(/escapes project root/);
  });

  it('resolves relative paths from the session cwd', () => {
    const resolved = resolveExcelInputPath('data/report.csv', {
      cwd: '/home/tower/workspace/projects/tower/analysis',
      projectRoot: '/home/tower/workspace/projects/tower',
      sessionId: 's1',
    });

    expect(resolved).toBe('/home/tower/workspace/projects/tower/analysis/data/report.csv');
  });

  it('builds excel_read and excel_query through context-aware factories', () => {
    const ctx = {
      cwd: '/home/tower/workspace/projects/tower',
      projectRoot: '/home/tower/workspace/projects/tower',
      sessionId: 'session-109',
    };

    const readTool = createExcelReadTool(ctx);
    const queryTool = createExcelQueryTool(ctx);

    expect(readTool.name).toBe('excel_read');
    expect(queryTool.name).toBe('excel_query');
    expect(readTool.execute).toEqual(expect.any(Function));
    expect(queryTool.execute).toEqual(expect.any(Function));
  });

  it('keeps generated temp files out of fixed /tmp singleton names', async () => {
    const financeSource = await import('node:fs/promises').then(fs => fs.readFile(
      path.resolve(import.meta.dirname, '../pi-finance-tools.ts'),
      'utf-8',
    ));

    expect(financeSource).toContain('fs.mkdtempSync');
    expect(financeSource).toContain('crypto.randomUUID');
    expect(financeSource).not.toContain("require('fs')");
    expect(financeSource).not.toContain("'/tmp/tower_py_run.py'");
    expect(financeSource).not.toContain("'/tmp/tower_excel_reader.py'");
  });
});
