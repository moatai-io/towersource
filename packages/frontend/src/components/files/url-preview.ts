// Owns: URL preview input normalization and validation. Public API: normalizePreviewUrl, isSafePreviewUrl.

/** Return whether a Viewer URL is a browser-loadable HTTP(S) or same-origin path without embedded credentials. */
export function isSafePreviewUrl(value: string): boolean {
  try {
    const url = new URL(value, window.location.origin);
    const isRelative = value.startsWith('/');
    return (isRelative || url.protocol === 'http:' || url.protocol === 'https:')
      && !url.username
      && !url.password
      && !/[\u0000-\u001f\u007f]/.test(value);
  } catch {
    return false;
  }
}

/** Normalize user input for a URL preview, adding HTTP only for localhost-style development addresses. */
export function normalizePreviewUrl(input: string): string {
  const value = input.trim();
  if (!value) throw new Error('URL을 입력하세요.');

  const candidate = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(value)
    ? `http://${value}`
    : value;

  if (!/^https?:\/\//i.test(candidate)) {
    throw new Error('http:// 또는 https://로 시작하는 URL을 입력하세요.');
  }
  if (!isSafePreviewUrl(candidate)) {
    throw new Error('이 URL은 미리보기에서 열 수 없습니다.');
  }
  return new URL(candidate).toString();
}
