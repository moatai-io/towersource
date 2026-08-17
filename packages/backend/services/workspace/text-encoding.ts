import { TextDecoder } from 'util';

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

/**
 * Normalize charset labels found in HTML/XML/CSS headers to WHATWG labels that
 * Node and browsers both understand. Korean legacy HTML commonly declares
 * CP949/MS949, while Node's TextDecoder accepts that family as `windows-949`.
 */
export function normalizeTextCharset(label?: string | null): string | null {
  if (!label) return null;
  const cleaned = label.trim().toLowerCase().replace(/^['"]|['"]$/g, '');
  if (!cleaned) return null;

  const alias = cleaned
    .replace(/_/g, '-')
    .replace(/^x-/, '');

  if (alias === 'utf8' || alias === 'unicode-1-1-utf-8') return 'utf-8';
  if (alias === 'cp949' || alias === 'ms949' || alias === 'windows-949' || alias === 'ks-c-5601-1987' || alias === 'ks-c-5601' || alias === 'euc-kr') {
    return 'euc-kr';
  }

  try {
    return new TextDecoder(alias).encoding;
  } catch {
    return null;
  }
}

/** Detect a charset explicitly declared in the first few KB of an HTML-like file. */
export function detectDeclaredTextCharset(buffer: Buffer): string | null {
  const head = buffer.subarray(0, 4096).toString('latin1');
  const metaCharset = head.match(/<meta\s+[^>]*charset\s*=\s*["']?([^\s"'/>;]+)/i)?.[1];
  const httpEquivCharset = head.match(/<meta\s+[^>]*http-equiv\s*=\s*["']?content-type["']?[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([^\s"';>]+)/i)?.[1]
    ?? head.match(/<meta\s+[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([^\s"';>]+)[^"']*["'][^>]*http-equiv\s*=\s*["']?content-type/i)?.[1];
  return normalizeTextCharset(metaCharset || httpEquivCharset);
}

function isValidUtf8(buffer: Buffer): boolean {
  try {
    UTF8_DECODER.decode(buffer);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decode shared text files without mojibake.
 *
 * Priority:
 * 1. Honor an explicit charset declaration from the file.
 * 2. Use UTF-8 when the bytes are valid UTF-8.
 * 3. Fall back to EUC-KR/Windows-949, matching common Korean legacy HTML.
 */
export function decodeTextBuffer(buffer: Buffer): { content: string; charset: string } {
  const charset = detectDeclaredTextCharset(buffer) || (isValidUtf8(buffer) ? 'utf-8' : 'euc-kr');
  return { content: new TextDecoder(charset).decode(buffer), charset };
}
