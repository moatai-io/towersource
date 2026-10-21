import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../db/pg-repo.js', () => ({ queryOne: vi.fn() }));
import { queryOne } from '../db/pg-repo.js';
import { createPdfExportTool } from './pi-pdf-export-tool.js';
import { createExcelWriteTool } from './pi-finance-tools-extra.js';
import { createPublishSiteTool } from './pi-publish-tool.js';

describe('private session generated output tools', () => {
  beforeEach(() => vi.mocked(queryOne).mockResolvedValue({ visibility: 'private' }));
  it.each(['pdf', 'excel', 'publish'])('allows private %s to reach ordinary validation', async kind => {
    const ctx = { cwd: '/nonexistent/private-project', projectRoot: '/nonexistent/private-project', projectId: 'p', userId: 1, sessionId: 'private' };
    const tool = kind === 'pdf' ? createPdfExportTool(ctx) : kind === 'excel' ? createExcelWriteTool(ctx) : createPublishSiteTool(ctx);
    const params = kind === 'pdf' ? { input_path: 'secret.html' } : kind === 'excel' ? { path: 'secret.xlsx', data: [{ secret: 'body' }] } : { name: 'private', sourceDir: '.' };
    const result: any = await tool.execute('t', params as any);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('Private session');
  });
});
