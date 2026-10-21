// Provider history keeps observation data; Tower UI/persisted visible prose does not.
const PREFIX = '[PDF observation batch=';
const CLOSE = '[/PDF observation]';
export function stripPdfObservationText(text: string): string {
  let output = ''; let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(PREFIX, cursor);
    if (start < 0) {
      const tail = text.slice(cursor);
      // Hold a marker split across streaming chunks, including a lone '['.
      for (let n = Math.min(PREFIX.length - 1, tail.length); n > 0; n--) {
        if (tail.endsWith(PREFIX.slice(0, n))) return output + tail.slice(0, -n);
      }
      return output + tail;
    }
    output += text.slice(cursor, start);
    const markerEnd = text.indexOf(']', start);
    if (markerEnd < 0) return output.trimEnd();
    const close = text.indexOf(CLOSE, markerEnd);
    // Legacy receipts did not delimit their note; fail closed for the rest of that block.
    if (close < 0) return output.trimEnd();
    cursor = close + CLOSE.length;
  }
  return output.trim();
}
