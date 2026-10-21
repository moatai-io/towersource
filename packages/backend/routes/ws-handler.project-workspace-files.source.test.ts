import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(process.cwd(), 'packages/backend/routes/ws-handler.ts'), 'utf8');

describe('WebSocket Project workspace file boundary', () => {
  it('routes Project text reads, writes, and directory listings through the workspace domain service', () => {
    expect(source).toContain('readProjectWorkspaceFileBytes');
    expect(source).toContain('writeProjectWorkspaceText');
    expect(source).toContain('listProjectWorkspaceDirectory');
    expect(source).toContain('compareAndSwapProjectWorkspaceText');
  });

  it('does not import direct legacy Worker file authority operations', () => {
    expect(source).not.toContain("from '../services/runtime-box/workbench-project-file-authority.js'");
    expect(source).not.toContain('readWorkerProjectFile');
    expect(source).not.toContain('compareAndSwapWorkerProjectFile');
  });

  it('preserves access checks before Project workspace mutations and listings', () => {
    const writeHandler = source.slice(source.indexOf('async function handleFileWrite'), source.indexOf('async function handleFileTree'));
    expect(writeHandler.indexOf('isPathAccessible')).toBeLessThan(writeHandler.indexOf('writeProjectWorkspaceText'));
    expect(writeHandler.indexOf('isPathWritableByRole')).toBeLessThan(writeHandler.indexOf('writeProjectWorkspaceText'));

    const treeStart = source.indexOf('async function handleFileTree');
    const treeHandler = source.slice(treeStart, source.indexOf('export function broadcastToUser', treeStart));
    expect(treeHandler.indexOf('isPathAccessible')).toBeLessThan(treeHandler.indexOf('listProjectWorkspaceDirectory'));
  });
});
