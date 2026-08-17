// Owns: chat/file markdown compatibility tweaks before ReactMarkdown parsing.
// Public API: normalizeMarkdownEmphasisBoundaries.

/**
 * CommonMark intentionally treats some intraword emphasis as plain text.
 *
 * That is usually correct for English identifiers (`foo**bar**baz`), but it
 * surprises Korean users when a bold phrase ends with punctuation/quotes and a
 * Korean suffix follows immediately, e.g. `**“문장”**입니다`.
 *
 * We insert an invisible entity after only those closing `**` markers outside
 * code. The entity gives micromark a boundary, ReactMarkdown decodes it to a
 * zero-width character, and the visible text remains unchanged.
 */
export function normalizeMarkdownEmphasisBoundaries(markdown: string): string {
  if (!markdown.includes('**')) return markdown;

  const pieces = markdown.split(/(\n)/);
  let inFence = false;
  let fenceMarker: '`' | '~' | null = null;
  let fenceLength = 0;

  return pieces.map((piece) => {
    if (piece === '\n') return piece;

    const fence = piece.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[1][0] as '`' | '~';
      const length = fence[1].length;
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
        fenceLength = length;
      } else if (marker === fenceMarker && length >= fenceLength) {
        inFence = false;
        fenceMarker = null;
        fenceLength = 0;
      }
      return piece;
    }

    if (inFence) return piece;
    return normalizeLineOutsideInlineCode(piece);
  }).join('');
}

function normalizeLineOutsideInlineCode(line: string): string {
  let output = '';
  let textBuffer = '';
  let inlineCodeFence = '';

  const flushText = () => {
    if (!textBuffer) return;
    output += normalizeStrongCloseBeforeWord(textBuffer);
    textBuffer = '';
  };

  for (let i = 0; i < line.length;) {
    if (line[i] !== '`') {
      if (inlineCodeFence) output += line[i];
      else textBuffer += line[i];
      i += 1;
      continue;
    }

    let j = i + 1;
    while (j < line.length && line[j] === '`') j += 1;
    const run = line.slice(i, j);

    if (!inlineCodeFence) {
      flushText();
      inlineCodeFence = run;
      output += run;
    } else {
      output += run;
      if (run === inlineCodeFence) inlineCodeFence = '';
    }
    i = j;
  }

  flushText();
  return output;
}

function normalizeStrongCloseBeforeWord(text: string): string {
  // The final char inside the strong span must be punctuation/symbol. Strong
  // spans ending with a Korean/Latin letter already parse correctly as-is.
  return text.replace(
    /\*\*((?:(?!\*\*).)*?[\p{P}\p{S}])\*\*(?=[\p{L}\p{N}])/gu,
    '**$1**&#8203;',
  );
}
