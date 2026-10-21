export type SpeechAlignment = { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };
export function activeSentence(alignment: SpeechAlignment, seconds: number): string | null {
  const index = alignment.character_start_times_seconds.findIndex((start, i) => start <= seconds && alignment.character_end_times_seconds[i] > seconds);
  if (index < 0) return null;
  const text = alignment.characters.join('');
  let start = index, end = index;
  while (start > 0 && !/[.!?。！？\n]/.test(text[start - 1])) start--;
  while (end < text.length && !/[.!?。！？\n]/.test(text[end])) end++;
  return text.slice(start, end + 1).trim() || null;
}
export function renderedSpeechText(root: HTMLElement): string {
  return Array.from(root.querySelectorAll('[data-speech-prose] p, [data-speech-prose] li, [data-speech-prose] h1, [data-speech-prose] h2, [data-speech-prose] h3'))
    .filter(el => !el.parentElement?.closest('li') && !el.closest('pre, table'))
    .map(el => el.textContent?.trim() || '').filter(Boolean).join('\n');
}
