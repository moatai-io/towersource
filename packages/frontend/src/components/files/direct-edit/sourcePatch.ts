// Owns: source-range matching and patch helpers for preview direct-edit.
// Public API: patchSourceRange, normalizeEditableText, locateTextInSource.

export type LocateTextResult = { start: number; end: number } | { error: 'not_found' | 'ambiguous' };

const HINT_LEN = 30;

export function patchSourceRange(source: string, start: number, end: number, replacement: string): string {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > source.length) {
    throw new Error('invalid source range');
  }
  return source.slice(0, start) + replacement + source.slice(end);
}

export function normalizeEditableText(value: string): string {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\n$/g, '');
}

function normalizeForMatch(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function containsInlineMarkdownSyntax(raw: string): boolean {
  // Direct-edit fallback replaces a whole rendered Markdown block with
  // plaintext. That is unsafe for mixed inline Markdown like `긴 **글** 의 끝`:
  // the browser edits rendered text, but source markers must be preserved.
  return /(^|[^\\])(?:\*\*|__|`|!\[[^\]]*\]\(|\[[^\]]+\]\([^)]*\))/.test(raw)
    || /(^|[\s([{])(?:\*[^*\s](?:[^*]*[^*\s])?\*|_[^_\s](?:[^_]*[^_\s])?_)(?=$|[\s.,!?;:)}\]])/.test(raw);
}

/**
 * Locate rendered text in a raw Markdown/HTML source string.
 *
 * This is intentionally conservative: repeated text without useful hints is
 * reported as ambiguous so direct-edit does not patch the wrong range.
 */
export function locateTextInSource({
  source,
  text,
  beforeHint = '',
  afterHint = '',
}: {
  source: string;
  text: string;
  beforeHint?: string;
  afterHint?: string;
}): LocateTextResult {
  if (!text) return { error: 'not_found' };

  const positions: number[] = [];
  let i = 0;
  while (i <= source.length - text.length) {
    const pos = source.indexOf(text, i);
    if (pos < 0) break;
    positions.push(pos);
    i = pos + 1;
  }

  if (positions.length === 0) return { error: 'not_found' };
  if (positions.length === 1) return { start: positions[0], end: positions[0] + text.length };

  const beforeKey = normalizeForMatch(beforeHint).slice(-HINT_LEN);
  const afterKey = normalizeForMatch(afterHint).slice(0, HINT_LEN);

  if (!beforeKey && !afterKey) return { error: 'ambiguous' };

  const scored = positions.map((p) => {
    const rawBefore = normalizeForMatch(source.slice(Math.max(0, p - HINT_LEN * 4), p)).slice(-HINT_LEN);
    const rawAfter = normalizeForMatch(source.slice(p + text.length, p + text.length + HINT_LEN * 4)).slice(0, HINT_LEN);
    let score = 0;
    if (beforeKey && rawBefore.endsWith(beforeKey)) score += 2;
    else if (beforeKey && rawBefore.includes(beforeKey)) score += 1;
    if (afterKey && rawAfter.startsWith(afterKey)) score += 2;
    else if (afterKey && rawAfter.includes(afterKey)) score += 1;
    return { p, score };
  }).sort((a, b) => b.score - a.score);

  if (scored[0].score > 0 && scored[0].score > (scored[1]?.score ?? -1)) {
    return { start: scored[0].p, end: scored[0].p + text.length };
  }

  return { error: 'ambiguous' };
}
