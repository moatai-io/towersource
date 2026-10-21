/** Worker-internal text shaping only. This module deliberately defines no HTTP/SSE contract. */
import { normalizeSpokenAnswer } from './voice-response-policy.js';

export class VoiceSentenceBufferLimitError extends Error {
  constructor() { super('Voice sentence buffer limit exceeded'); }
}

/**
 * Incremental sentence boundaries. Do not speak an unclosed code block or a decimal
 * fragment. A terminal success flushes an unpunctuated tail; cancel/error does not.
 */
export class VoiceSentenceAssembler {
  private pending = '';
  constructor(private readonly maxBufferedChars = 32_768) {}

  push(delta: string): string[] {
    this.pending += delta;
    if (this.pending.length > this.maxBufferedChars) throw new VoiceSentenceBufferLimitError();
    return this.drain(false);
  }
  finish(): string[] { return this.drain(true); }
  clear(): void { this.pending = ''; }

  private drain(terminal: boolean): string[] {
    const sentences: string[] = [];
    let from = 0;
    let fenced = false;
    let inline = false;
    for (let i = 0; i < this.pending.length; i += 1) {
      if (this.pending.startsWith('```', i)) { fenced = !fenced; i += 2; continue; }
      if (this.pending[i] === '`' && !fenced) { inline = !inline; continue; }
      if (fenced || inline) continue;
      const char = this.pending[i];
      const next = this.pending[i + 1];
      // Look ahead one character: a chunk ending in '.' may continue as 3.14,
      // an abbreviation or an ellipsis. Whitespace/newline is a safe boundary.
      const tokenStart = this.pending.slice(from, i + 1).search(/\S+$/u);
      const token = this.pending.slice(tokenStart < 0 ? from : from + tokenStart, i + 1);
      const urlToken = /^(?:https?:\/\/|www\.)/iu.test(token);
      const koreanSentenceEnd = char === '.' && /[가-힣]/u.test(this.pending[i - 1] ?? '');
      // URL punctuation (including IDN hostnames and query strings) belongs to
      // the token. Newline alone is NOT a sentence: don't speak Markdown headings
      // or list preambles as the first meaningful answer before content arrives.
      const boundary = !urlToken && (koreanSentenceEnd || /[!?。！？]/u.test(char)
        || (char === '.' && next !== undefined && /\s/u.test(next)));
      if (!boundary) continue;
      const sentence = normalizeSpokenAnswer(this.pending.slice(from, i + 1));
      if (sentence) sentences.push(sentence);
      from = i + 1;
    }
    this.pending = this.pending.slice(from);
    if (terminal && this.pending) {
      // Unclosed markup is not streamed as speech even on an otherwise successful
      // completion; it is a text-shaping error rather than permission to read code.
      if (fenced || inline) throw new Error('Voice text ended inside code markup');
      const tail = normalizeSpokenAnswer(this.pending);
      if (tail) sentences.push(tail);
      this.pending = '';
    }
    return sentences;
  }
}

async function nextUntilAbort<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return iterator.next(); })
      .then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * Pull-based internal adapter: at most one backend delta is read at a time. The
 * consumer awaits playout/admission before requesting another sentence, providing
 * application-level backpressure (not a claim that TCP/provider buffers are bounded).
 * Each yield is gated again so a late delta cannot escape after a revision change.
 * Transport must supply ONLY validated assistant-answer deltas and end successfully
 * ONLY on its explicit terminal-success event. Never feed commentary/tool text.
 */
export async function* voiceSentenceStream(options: {
  deltas: AsyncIterable<string>;
  signal: AbortSignal;
  isCurrent: () => boolean;
  maxBufferedChars?: number;
}): AsyncGenerator<string> {
  const assembler = new VoiceSentenceAssembler(options.maxBufferedChars);
  const iterator = options.deltas[Symbol.asyncIterator]();
  const assertCurrent = () => {
    options.signal.throwIfAborted();
    if (!options.isCurrent()) throw new DOMException('Voice revision superseded', 'AbortError');
  };
  try {
    for (;;) {
      assertCurrent();
      const item = await nextUntilAbort(iterator, options.signal);
      assertCurrent();
      const sentences = item.done ? assembler.finish() : assembler.push(item.value);
      for (const sentence of sentences) { assertCurrent(); yield sentence; }
      if (item.done) return;
    }
  } finally {
    assembler.clear();
    // Do not block shutdown on a producer that ignores abort while its next() hangs.
    void Promise.resolve().then(() => iterator.return?.()).catch(() => {});
  }
}
