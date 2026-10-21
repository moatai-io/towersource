/** Preserve source text exactly; prefer paragraph/sentence boundaries within the cap. */
export function splitSpeechText(text: string, max = 600): string[] {
  if (!Number.isInteger(max) || max < 2) throw new Error('Invalid chunk limit');
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    const window = remaining.slice(0, max);
    let boundary = window.lastIndexOf('\n') + 1;
    if (boundary < max / 3) {
      boundary = 0;
      for (const match of window.matchAll(/[.!?。！？](?:\s|$)/g)) boundary = match.index! + match[0].length;
    }
    if (boundary < max / 3) boundary = window.lastIndexOf(' ') + 1;
    if (boundary < max / 3) boundary = max;
    if (/[\uD800-\uDBFF]/.test(remaining[boundary - 1])) boundary--;
    chunks.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
