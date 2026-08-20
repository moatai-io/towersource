import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './FilesWorkspace.tsx'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../locales/en/files.json'), 'utf8'));
const ko = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../locales/ko/files.json'), 'utf8'));

const keys = [
  'noProjectFiles', 'noProjectFilesDescription', 'currentDocumentWorkspace',
  'selectAiTeammateForDocuments', 'itemCount', 'projectFiles', 'projectInstructions',
  'add', 'newFile', 'newFolder', 'uploadFiles', 'uploadFolder', 'search', 'select',
  'refresh', 'allFiles', 'publishedMaterials', 'sharedFiles', 'createdSkills',
  'sharedSkills', 'selectedCount', 'rename', 'move', 'download', 'copyPath',
  'copyInternalLink', 'delete', 'copyAndSend', 'recentActions', 'undo',
  'parentFolder', 'foldersOnly', 'filesOnly', 'showHiddenFiles',
];

describe('Files Workspace locale contract', () => {
  it('provides matching English and Korean navigation keys', () => {
    for (const key of keys) {
      expect(en.workspace[key], `missing English workspace key: ${key}`).toBeTruthy();
      expect(ko.workspace[key], `missing Korean workspace key: ${key}`).toBeTruthy();
    }
  });

  it('routes the primary navigation controls through the files namespace', () => {
    expect(source).toContain('useTranslation("files")');
    for (const key of ['noProjectFiles', 'projectFiles', 'add', 'search', 'selectedCount', 'parentFolder']) {
      expect(source).toContain(`workspace.${key}`);
    }
    expect(source).not.toContain('aria-label="추가"');
    expect(source).not.toContain('placeholder="Project 전체에서 파일명/경로 검색"');
  });
});
