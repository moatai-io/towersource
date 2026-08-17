// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fileServeUrl, isDirectoryLikeTowerPath, isPreviewableImageFilePath, splitFilePathsInText } from './file-path-links';

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
