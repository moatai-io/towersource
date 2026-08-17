import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const sourceRoot = path.resolve(import.meta.dirname, '../..');

function source(relativePath: string): string {
  return fs.readFileSync(path.join(sourceRoot, relativePath), 'utf8');
}

describe('notification surface contracts', () => {
  it('mounts a single app-level Toaster', () => {
    const files = [
      'App.tsx',
      'components/files/FileViewerPage.tsx',
    ];
    const count = files.reduce((sum, file) => sum + (source(file).match(/<Toaster\b/g) || []).length, 0);
    expect(count).toBe(1);
    expect(source('components/files/FileViewerPage.tsx')).not.toContain("from 'sonner'");
  });

  it('keeps restart and active-context notification feedback on one primary surface', () => {
    const runtime = source('hooks/useChatRuntime.ts');
    expect(runtime).not.toContain("toastWarning('Server restarted')");
    expect(runtime).toContain('UpdateBanner is the single user-facing surface');
    expect(runtime).toContain("sessionState.activeView === 'chat'");
    expect(runtime).toContain('sessionState.activeSessionId === notificationSessionId');
    expect(runtime).toContain('if (isViewingNotificationSession) break;');
    expect(runtime).not.toContain('isViewingNotificationRoom');
  });
});
