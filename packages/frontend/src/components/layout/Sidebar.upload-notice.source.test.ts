import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const sidebarPath = path.resolve(import.meta.dirname, './Sidebar.tsx');
const projectFilesPath = path.resolve(import.meta.dirname, '../../features/navigation-sidebar/project-files/SidebarProjectFiles.tsx');
const filesToolbarPath = path.resolve(import.meta.dirname, './SidebarFilesToolbar.tsx');

describe('Sidebar upload notice contract', () => {
  it('routes upload batch completion through one shared terminal notice', () => {
    const sidebar = fs.readFileSync(sidebarPath, 'utf8');
    const projectFiles = fs.readFileSync(projectFilesPath, 'utf8');
    const filesToolbar = fs.readFileSync(filesToolbarPath, 'utf8');
    const source = `${sidebar}\n${projectFiles}\n${filesToolbar}`;
    expect(projectFiles).toContain("import { notifyUploadResult } from '../../../utils/upload-notice'");
    expect((source.match(/notifyUploadResult\(/g) || []).length).toBeGreaterThanOrEqual(6);
    expect(source).not.toMatch(/toastSuccess\(`Uploading /);
    expect(source).not.toMatch(/toastSuccess\(`\$\{ok\} file\(s\) uploaded/);
    expect(source).not.toMatch(/toastError\(`\$\{fail\} file\(s\) failed/);
  });
});
