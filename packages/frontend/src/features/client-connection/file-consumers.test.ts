import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

// Wiring guard only; URL behavior is covered by connection.test.ts and pdf-open.test.ts.
it.each([
  'files/FileViewerPage.tsx', 'files/OfficePreviewToolbar.tsx', 'files/FileTree.tsx',
  'files/SqlitePreview.tsx', 'files/XlsxPreview.tsx', 'layout/FileTabBar.tsx',
  'layout/ViewerPane.tsx', 'layout/ContextPanel.tsx',
])('routes every file-serving URL through the connection boundary: %s', file => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '../../components', file), 'utf8');
  const urls = source.match(/`\/api\/files\/serve\?/g) || [];
  const wrapped = source.match(/towerHttpUrl\(`\/api\/files\/serve\?/g) || [];
  expect(urls.length).toBeGreaterThan(0);
  expect(wrapped.length).toBe(urls.length);
});

it('routes the actual chat attachment endpoint through the connection boundary', () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '../../components/chat/InputBox.tsx'), 'utf8');
  expect(source).toContain('url: towerHttpUrl(`/api/session-attachments/${encodeURIComponent(activeSessionId)}`)');
});
