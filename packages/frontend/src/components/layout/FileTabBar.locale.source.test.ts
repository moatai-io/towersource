import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(__dirname, 'FileTabBar.tsx'), 'utf8');

describe('FileTabBar locale contract', () => {
  it('uses layout locale keys for tab feedback, sidebar reveal, and the AI panel', () => {
    for (const key of [
      'chatTabFallback',
      'fileOwnerNotFound',
      'sidebarTargetNotFound',
      'tabPinned',
      'tabUnpinned',
      'workspaceFiles',
      'askAiAboutFileNamed',
      'renameSession',
    ]) {
      expect(source).toContain(key);
    }
  });

  it('keeps the legacy project-home title only as a stored tab compatibility check', () => {
    expect(source).toContain("s.title === '프로젝트 홈'");
    expect(source).toContain("t('workspaceFiles')");
  });
});
