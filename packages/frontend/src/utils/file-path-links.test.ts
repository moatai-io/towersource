// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { downloadTowerFile, fileServeUrl, isDirectoryLikeTowerPath, isPreviewableImageFilePath, splitFilePathsInText } from './file-path-links';

function extractLinkedPaths(text: string): string[] {
  const paths: string[] = [];
  splitFilePathsInText(
    text,
    () => {},
    (filePath) => {
      paths.push(filePath);
      return filePath;
    },
  );
  return paths;
}

describe('file path auto-linking', () => {
  it('links Korean workspace directory paths with trailing slash', () => {
    const text = '산출물: ~/workspace/projects/project-43b24a76/reports/nonsan-nangcheong/항목별_제출서류/DOCX_워드호환/';

    expect(extractLinkedPaths(text)).toEqual([
      '~/workspace/projects/project-43b24a76/reports/nonsan-nangcheong/항목별_제출서류/DOCX_워드호환/',
    ]);
  });

  it('links absolute workspace directory paths without a trailing slash', () => {
    const text = '폴더: /home/tower/workspace/projects/demo-org/uploads';

    expect(extractLinkedPaths(text)).toEqual([
      '/home/tower/workspace/projects/demo-org/uploads',
    ]);
  });

  it('links Tower repo file paths emitted as portable ~/tower paths', () => {
    const text = '수정: ~/tower/packages/frontend/public/favicon.svg';

    expect(extractLinkedPaths(text)).toEqual([
      '~/tower/packages/frontend/public/favicon.svg',
    ]);
  });

  it('still links Korean file paths with previewable extensions', () => {
    const text = '문서: ~/workspace/projects/project-43b24a76/reports/nonsan-nangcheong/항목별_제출서류/DOCX_워드호환/안내문.docx';

    expect(extractLinkedPaths(text)).toEqual([
      '~/workspace/projects/project-43b24a76/reports/nonsan-nangcheong/항목별_제출서류/DOCX_워드호환/안내문.docx',
    ]);
  });

  it('classifies trailing slash paths as directories', () => {
    expect(isDirectoryLikeTowerPath('~/workspace/projects/p/한글/')).toBe(true);
    expect(isDirectoryLikeTowerPath('~/tower/packages/frontend/public')).toBe(true);
    expect(isDirectoryLikeTowerPath('/home/tower/workspace/projects/demo-org/uploads')).toBe(true);
    expect(isDirectoryLikeTowerPath('~/workspace/projects/p/한글/report.md')).toBe(false);
  });

  it('serves portable ~/tower paths through the authenticated file endpoint', () => {
    const url = fileServeUrl('~/tower/packages/frontend/public/favicon.svg');

    expect(url).toContain('/api/files/serve?path=');
    expect(decodeURIComponent(url)).toContain('path=~/tower/packages/frontend/public/favicon.svg');
  });

  it('classifies common image URLs and file paths as inline-previewable', () => {
    expect(isPreviewableImageFilePath('https://example.com/a/hero.PNG?cache=1')).toBe(true);
    expect(isPreviewableImageFilePath('~/workspace/projects/p/icon.svg')).toBe(true);
    expect(isPreviewableImageFilePath('/home/tower/workspace/projects/p/photo.avif')).toBe(true);
    expect(isPreviewableImageFilePath('/home/tower/workspace/projects/p/report.pdf')).toBe(false);
  });
});

 describe('artifact handoff formatting contract', () => {
  it('links each qualified evidence path without guessing a project for bare relative paths', () => {
    const paths = [
      '~/workspace/projects/demo/work/voice-runtime/design-audit.md',
      '~/workspace/projects/demo/work/voice-runtime/integration-test.log',
      '~/workspace/projects/demo/work/voice-runtime/audit-input-results-after.json',
    ];
    expect(extractLinkedPaths(paths.join('\n'))).toEqual(paths);
    expect(extractLinkedPaths('work/voice-runtime/design-audit.md')).toEqual([]);
  });
});


describe('authenticated download', () => {
  it('uses download endpoint and preserves a foreign Project path; rejects denied access', async () => {
    localStorage.setItem('token', 'synthetic-test-token');
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 403 }));
    try {
      await expect(downloadTowerFile('/home/example/workspace/projects/other/result.zip')).rejects.toThrow('HTTP 403');
      expect(request).toHaveBeenCalledWith('/api/files/serve?path=%2Fhome%2Fexample%2Fworkspace%2Fprojects%2Fother%2Fresult.zip&download=1',
        { headers: { Authorization: 'Bearer synthetic-test-token' } });
    } finally { request.mockRestore(); localStorage.removeItem('token'); }
  });
});
