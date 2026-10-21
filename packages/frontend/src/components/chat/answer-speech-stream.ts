/** Commit only complete sentences; hold ambiguous markdown/code until completion. */
export function stableSpeechPrefix(text: string, complete: boolean): string {
  if (complete) return text;
  let boundary = 0;
  for (const match of text.matchAll(/[.!?。！？](?=\s|$)/g)) {
    const candidate = text.slice(0, match.index! + 1);
    if ((candidate.match(/```/g)?.length || 0) % 2 || /https?:\/\/\S*$/.test(candidate)) continue;
    if ((candidate.match(/\[/g)?.length || 0) !== (candidate.match(/\]/g)?.length || 0)) continue;
    boundary = match.index! + 1;
  }
  const prefix = text.slice(0, boundary);
  return prefix;
}
export function speechChunks(text: string, first: boolean): string[] {
  const result: string[] = [];
  let rest = text;
  while (rest) {
    const cap = first ? 200 : 400;
    const window = rest.slice(0, cap);
    const matches = [...window.matchAll(/[.!?。！？](?=\s|$)/g)];
    let end = first && matches.length ? matches[0].index! + 1 : matches.length ? matches.at(-1)!.index! + 1 : Math.min(rest.length, cap);
    if (/[\uD800-\uDBFF]/.test(rest[end - 1])) end--;
    result.push(rest.slice(0, end)); rest = rest.slice(end); first = false;
  }
  return result.filter(s => s.trim());
}
