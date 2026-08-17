import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isSafePreviewUrl, normalizePreviewUrl } from './url-preview';

describe('URL preview validation', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { location: { origin: 'https://tower.example.com' } });
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

  it('requires explicit protocols for non-localhost domains', () => {
    expect(() => normalizePreviewUrl('example.com')).toThrow();
  });
});
