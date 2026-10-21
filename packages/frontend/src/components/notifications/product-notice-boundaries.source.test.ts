import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = path.resolve(import.meta.dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('high-risk product notice boundaries', () => {

  it('routes Runtime Box failures through stable event codes', () => {
    const source = read('components/runtime/RuntimeBoxPanel.tsx');
    for (const code of [
      'runtime.load.failed',
      'runtime.capacity.save.failed',
      'runtime.logs.load.failed',
      'runtime.service.stop.failed',
      'runtime.box.stop.failed',
      'runtime.box.cleanup.failed',
    ]) expect(source).toContain(`code: '${code}'`);
    expect(source).not.toMatch(/toastError\([^\n]*(?:err\?\.message|err\.message)/);
  });

  it('routes Sidebar API and exception detail through stable event codes', () => {
    const source = [
      read('components/layout/Sidebar.tsx'),
      read('features/navigation-sidebar/project-files/SidebarProjectFiles.tsx'),
    ].join('\n');
    for (const code of [
      'sidebar.personal.rename.failed',
      'sidebar.personal.archive.failed',
      'sidebar.session.move.failed',
      'sidebar.file.create.failed',
      'sidebar.cwd.change.failed',
      'sidebar.project.delete.failed',
      'sidebar.file.move.failed',
    ]) expect(source).toContain(`code: '${code}'`);
    expect(source).toContain('reportUploadUnknown(');
    expect(source).not.toMatch(/toastError\([^\n]*(?:data\.error|err\.error|err\.message|err instanceof Error|error instanceof Error)/);
  });
});
