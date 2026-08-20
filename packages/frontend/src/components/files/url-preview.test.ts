import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../../i18n';
import { isSafePreviewUrl, normalizePreviewUrl } from './url-preview';

describe('URL preview validation', () => {
  beforeEach(async () => {
    vi.stubGlobal('window', { location: { origin: 'https://tower.example.com' } });
    await i18n.changeLanguage('en');
  });

  it('accepts HTTP and HTTPS URLs', () => {
    expect(normalizePreviewUrl('https://example.com/path')).toBe('https://example.com/path');
    expect(normalizePreviewUrl('http://example.com')).toBe('http://example.com/');
  });

  it('adds HTTP to localhost development URLs', () => {
    expect(normalizePreviewUrl('localhost:32354/settings')).toBe('http://localhost:32354/settings');
    expect(normalizePreviewUrl('127.0.0.1:3000')).toBe('http://127.0.0.1:3000/');
  });

  it('rejects dangerous protocols and embedded credentials', () => {
    expect(() => normalizePreviewUrl('javascript:alert(1)')).toThrow();
    expect(() => normalizePreviewUrl('data:text/html,hello')).toThrow();
    expect(() => normalizePreviewUrl('https://user:secret@example.com')).toThrow();
    expect(isSafePreviewUrl('file:///etc/passwd')).toBe(false);
  });

  it('uses the active locale for validation errors', async () => {
    expect(() => normalizePreviewUrl('')).toThrow('Enter a URL.');
    expect(() => normalizePreviewUrl('example.com')).toThrow('Enter a URL that starts with http:// or https://.');
    expect(() => normalizePreviewUrl('https://user:secret@example.com')).toThrow('This URL cannot be opened in the preview.');

    await i18n.changeLanguage('ko');
    expect(() => normalizePreviewUrl('')).toThrow('URL을 입력하세요.');
    expect(() => normalizePreviewUrl('example.com')).toThrow('http:// 또는 https://로 시작하는 URL을 입력하세요.');
  });
});
