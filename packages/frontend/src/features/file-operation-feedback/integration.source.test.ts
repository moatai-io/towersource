import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const source = (path: string) => readFileSync(`packages/frontend/src/${path}`, 'utf8');
it('all file save entry points await an HTTP result through the same policy', () => {
  for (const file of ['App.tsx', 'hooks/useChatRuntime.ts', 'hooks/usePersonalViewerActions.ts', 'components/files/FileViewerPage.tsx']) {
    expect(source(file)).toMatch(/saveFileOperation\((?:path|filePath)/);
  }
});
it('file viewers render path-scoped feedback instead of save failure toasts', () => {
  for (const file of ['components/layout/ContextPanel.tsx', 'components/files/FileViewerPage.tsx']) expect(source(file)).toContain('<FileOperationFeedback scope={saveScope(');
  expect(source('App.tsx')).not.toContain("toastSuccess('Prompt saved')");
  expect(source('hooks/useChatRuntime.ts')).not.toContain("send({ type: 'file_write', path, content })");
});
it('upload owners render inline feedback and do not emit upload failure toasts', () => {
  for (const file of ['components/files/FilesWorkspace.tsx', 'components/files/FileTree.tsx', 'components/layout/Sidebar.tsx', 'features/navigation-sidebar/project-files/SidebarProjectFiles.tsx', 'components/chat/InputBox.tsx', 'components/files/markdown-editor/MarkdownEditor.tsx']) {
    expect(source(file)).toContain('<FileOperationFeedback');
    expect(source(file)).toMatch(/reportUpload(?:Failure|Unknown)\(/);
    expect(source(file)).not.toMatch(/toastError\([^\n]*(?:Upload failed|uploadFailed|partialUploadFailed|fileInsertFailed)/);
  }
});
it('isolates tree instances while sharing scope with nested nodes', () => {
  const tree = source('components/files/FileTree.tsx');
  expect(tree).toContain('const instanceId = useId()');
  expect(tree).toContain('uploadFeedbackScope={uploadFeedbackScope}');
  expect(tree).not.toContain("'upload:tree'");
});
it('legacy save frames cannot acknowledge unrelated edits', () => {
  const runtime = source('hooks/useChatRuntime.ts');
  const frame = runtime.split("case 'file_saved': {")[1].split("case 'file_changed':")[0];
  expect(frame).not.toContain('markSaved(');
  expect(frame).not.toContain('toastSuccess(');
});
it('sidebar upload entry points reuse the transport owner', () => {
  for (const file of ['components/layout/Sidebar.tsx', 'components/layout/SidebarFilesToolbar.tsx']) {
    expect(source(file)).not.toContain("fetch('/api/files/upload'");
    expect(source(file)).toContain('await uploadDroppedFiles(');
  }
});
