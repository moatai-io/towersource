export type DictationInsertionState = {
  start: number; end: number; owned: string; transcript: string; snapshot: string;
  /** Sticky once the user or another draft operation changes the text. */
  edited?: boolean;
};

/** Final events are idempotent; user edits permanently relinquish replacement ownership. */
export function updateDictation(input: string, text: string, state: DictationInsertionState) {
  const edited = !!state.edited || input !== state.snapshot;
  if (text === state.transcript) return { value: input, state: { ...state, edited, snapshot: input } };
  const suffix = text.startsWith(state.transcript) ? text.slice(state.transcript.length) : '';
  const start = edited ? input.length : state.start;
  const end = edited ? input.length : state.end;
  // Revisions to earlier recognized words must never restore user-deleted text.
  const added = edited ? suffix : text;
  const value = input.slice(0, start) + added + input.slice(end);
  return { value, state: { start, end: start + added.length, owned: added, transcript: text, snapshot: value, edited } };
}
