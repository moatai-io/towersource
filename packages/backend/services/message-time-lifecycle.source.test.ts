import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const messageStore = fs.readFileSync(path.resolve(import.meta.dirname, './message-store.ts'), 'utf8');
const piEngine = fs.readFileSync(path.resolve(import.meta.dirname, '../engines/pi-engine.ts'), 'utf8');
const terminalizer = fs.readFileSync(path.resolve(import.meta.dirname, '../engines/pi/run-terminalizer.ts'), 'utf8');

describe('message completion time lifecycle', () => {
  it('does not finalize completed_at from intermediate Pi iteration metrics', () => {
    expect(messageStore).toContain('finalize_completed_at?: boolean');
    expect(messageStore).toContain('WHEN $16::boolean THEN NOW()');
    expect(piEngine).not.toContain('finalizeCompletedAt: true');
  });

  it('finalizes completed_at from terminal root-turn metrics', () => {
    expect(terminalizer).toContain('finalizeCompletedAt: true');
  });
});
