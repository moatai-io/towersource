/** Tower's artifact envelope permits fenced Markdown inside its body.
 * Same-length bare inner fences are ambiguous: use a longer outer fence for
 * unlabelled code. Labelled fences are tracked for legacy triple-fence output.
 * Never emit an incomplete envelope (including during streaming).
 */
export interface ArtifactFenceMatch {
  index: number;
  end: number;
  attrs: string;
  body: string;
}

export function parseArtifactFences(source: string, streaming = false): ArtifactFenceMatch[] {
  const lines = [...source.matchAll(/[^\n]*(?:\n|$)/g)].filter((m) => m[0]);
  const result: ArtifactFenceMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    const opening = lines[i][0].replace(/\r?\n$/, '').match(/^ {0,3}(`{3,})tower-artifact[ \t]+([^`]*)$/);
    if (!opening) continue;
    const start = lines[i].index!;
    const bodyStart = start + lines[i][0].length;
    const outerLength = opening[1].length;
    let inner: { char: string; length: number } | undefined;
    let closed = false;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j][0].replace(/\r?\n$/, '');
      const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (!fence) continue;
      const marker = fence[1];
      const info = fence[2].trim();
      if (inner) {
        if (!info && marker[0] === inner.char && marker.length >= inner.length) inner = undefined;
        continue;
      }
      if (marker[0] === '`' && marker.length >= outerLength && !info) {
        if (streaming && !lines[j][0].endsWith('\n')) break;
        const closingStart = lines[j].index!;
        result.push({ index: start, end: closingStart + line.length, attrs: opening[2],
          body: source.slice(bodyStart, closingStart).replace(/\r?\n$/, '') });
        i = j;
        closed = true;
        break;
      }
      inner = { char: marker[0], length: marker.length };
    }
    // Do not reinterpret nested text as new envelopes in an incomplete body.
    if (!closed) break;
  }
  return result;
}
