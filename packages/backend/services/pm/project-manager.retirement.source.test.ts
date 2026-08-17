import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const manager = fs.readFileSync(new URL('./project-manager.ts', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../../routes/api.ts', import.meta.url), 'utf8');
const sessions = fs.readFileSync(new URL('../session/session-manager.ts', import.meta.url), 'utf8');
const runtime = fs.readFileSync(new URL('../runtime-box/runtime-box-manager.ts', import.meta.url), 'utf8');

describe('Primary Agent retirement source contract', () => {
  it('retires without deleting or detaching conversations and files', () => {
    const start = manager.indexOf('export async function retireProject');
    const end = manager.indexOf('export async function restoreProject', start);
    const source = manager.slice(start, end);
    expect(source).toContain("lifecycle_status = 'retired'");
    expect(source).toContain('archived = 1');
    expect(source).not.toContain('DELETE FROM projects');
    expect(source).not.toContain('UPDATE sessions SET project_id = NULL');
    expect(source).not.toContain('fs.rm');
  });

  it('keeps DELETE as a compatibility retirement alias and provides explicit restore', () => {
    expect(api).toContain("router.post('/projects/:id/retire', retireProjectRoute)");
    expect(api).toContain("router.delete('/projects/:id', retireProjectRoute)");
    expect(api).toContain("router.post('/projects/:id/restore'");
    expect(api).toContain("await stopBox(box.id, 'stopped')");
    expect(api).toContain('for (const box of boxes)');
    expect(api).not.toContain('deleteProject(projectId)');
  });

  it('blocks new sessions and Runtime Box starts for retired Projects', () => {
    expect(sessions).toContain("throw new Error('Agent is retired; new sessions are disabled')");
    expect(runtime).toContain('is retired; Runtime Box start is disabled');
    for (const source of [sessions, runtime]) expect(source).toContain("(project.lifecycle_status ?? 'active') !== 'active'");
  });
});
