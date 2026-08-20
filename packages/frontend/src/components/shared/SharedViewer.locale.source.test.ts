import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(__dirname, 'SharedViewer.tsx'), 'utf8');

describe('SharedViewer locale contract', () => {
  it('routes shared-link states, preview controls, download, and PDF guidance through share locale keys', () => {
    for (const key of [
      'codePreview',
      'invalidLink',
      'expiredOrRevoked',
      'loadFailed',
      'preview',
      'raw',
      'download',
      'pdfViewerHint',
      'openInNewTab',
    ]) expect(source).toContain(key);
  });

  it('preserves tokenized shared file fetch, render, and download endpoints', () => {
    expect(source).toContain('fetch(`/api/shared/${token}`)');
    expect(source).toContain('`/api/shared/${token}?render=1`');
    expect(source).toContain('`/api/shared/${token}?download=1`');
  });
});
