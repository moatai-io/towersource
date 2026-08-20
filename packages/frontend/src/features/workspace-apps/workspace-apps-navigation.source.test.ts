import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const app = fs.readFileSync(path.resolve(import.meta.dirname, '../../App.tsx'), 'utf8');
const header = fs.readFileSync(path.resolve(import.meta.dirname, '../../components/layout/Header.tsx'), 'utf8');
const urlSync = fs.readFileSync(path.resolve(import.meta.dirname, '../../hooks/useUrlSync.ts'), 'utf8');

/**
 * Product boundary only: Workspace Apps may keep evolving internally, but it is
 * not a primary workspace until a separate product decision enables it.
 * Do not assert component structure, labels, or implementation details here.
 */
describe('Workspace Apps primary navigation boundary', () => {
  it('does not expose Workspace Apps through primary navigation, app routing, or URL restore', () => {
    expect(header).not.toMatch(/key:\s*['"]workspaceApps['"]/);
    expect(app).not.toMatch(/activeView\s*===\s*['"]workspaceApps['"]/);
    expect(urlSync).not.toMatch(/['"]workspaceApps['"]/);
  });
});
