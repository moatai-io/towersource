import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ ensure: vi.fn(), record: vi.fn() }));
vi.mock('./file-checkpoint-repo.js', () => ({ ensureTurnCheckpoint: mocks.ensure, recordCheckpointFileChange: mocks.record }));
import { beginFileCheckpointCapture, completeFileCheckpointCapture, markTurnCheckpointPartial } from './file-checkpoint-capture.js';

const roots: string[] = [];
beforeEach(() => { vi.clearAllMocks(); mocks.ensure.mockResolvedValue('checkpoint-1'); });
afterEach(async () => { await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });

async function root() { const p = await mkdtemp(join(tmpdir(), 'tower-capture-')); roots.push(p); return p; }

describe('file checkpoint capture lifecycle', () => {
  it('captures before prior to mutation and after only on completion', async () => {
    const projectRoot = await root(); const filePath = join(projectRoot, 'a.txt'); await writeFile(filePath, 'before');
    const capture = await beginFileCheckpointCapture({ rootTurnId: 't1', sessionId: 's1', projectRoot, filePath, toolName: 'edit' });
    await writeFile(filePath, 'after');
    await completeFileCheckpointCapture(capture);
    expect(capture.before.content?.toString()).toBe('before');
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ before: expect.objectContaining({ exists: true }), after: expect.objectContaining({ exists: true }) }));
    expect(await readFile(filePath, 'utf8')).toBe('after');
  });

  it('marks shell-mediated turns as partial coverage', async () => {
    await markTurnCheckpointPartial({ rootTurnId: 't1', sessionId: 's1' });
    expect(mocks.ensure).toHaveBeenCalledWith({ rootTurnId: 't1', sessionId: 's1', partial: true });
  });
});
