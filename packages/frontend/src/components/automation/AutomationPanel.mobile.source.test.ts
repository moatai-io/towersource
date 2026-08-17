import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './AutomationPanel.tsx'), 'utf8');
const app = fs.readFileSync(path.resolve(import.meta.dirname, '../../App.tsx'), 'utf8');

describe('mobile automation and personal Viewer contracts', () => {
  it('opens personal Todo, files, and new notes in the mobile Viewer overlay', () => {
    expect(app).toContain('const revealPersonalViewer = useCallback');
    expect(app).toContain('useSessionStore.getState().openMobileContext()');
    expect(app).toMatch(/openPersonalFileInViewer[\s\S]*store\.openTab\(contentUrl[\s\S]*revealPersonalViewer\(\)/);
    expect(app).toMatch(/openPersonalTodosInViewer[\s\S]*personal:\/\/todos[\s\S]*revealPersonalViewer\(\)/);
    expect(app).toContain('await openPersonalFileInViewer(data.uri)');
  });

  it('uses stacked mobile controls and compact automation rows', () => {
    expect(source).toContain('flex-col gap-3 sm:mb-4 sm:flex-row');
    expect(source).toContain('w-full rounded-lg bg-blue-600');
    expect(source).toContain('grid-cols-[auto_1fr_auto_auto]');
    expect(source).toContain('sm:flex sm:gap-2.5');
  });

  it('renders the edit form as a mobile bottom sheet with safe-area actions', () => {
    expect(source).toContain('items-end justify-center');
    expect(source).toContain('max-h-[calc(100dvh-3rem)]');
    expect(source).toContain('env(safe-area-inset-bottom,0px)');
  });
});
