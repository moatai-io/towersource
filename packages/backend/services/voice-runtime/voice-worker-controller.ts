/** Worker-only HTTP and speech scheduler. No backend engine/DB imports. */
import { randomUUID } from 'node:crypto';
import { voiceSentenceStream } from './voice-worker-sentence-stream.js';
import { normalizeSpokenAnswer } from './voice-response-policy.js';
import { VoiceTurnOrchestrator, type VoiceInputRevision } from './voice-turn-orchestrator.js';

/** Room-scoped UI protocol. speaking means server output, never browser playback. */
export interface VoiceWorkerUiEvent {
  v: 1;
  seq: number;
  kind: 'input' | 'sentence' | 'waiting' | 'reset' | 'error';
  code?: string;
  turnId?: string;
  revision?: number;
  text?: string;
  final?: boolean;
  speechId?: string;
  state?: 'queued' | 'speaking' | 'completed' | 'interrupted';
}
export const VOICE_UI_TOPIC = 'tower.voice.ui.v1';
export const VOICE_TURN_DEADLINE_MS = 90_000;
export const VOICE_MAX_REQUEST_ATTEMPTS = 10;

export interface VoiceWorkerTurn { turnId: string; revision: number; transcript: string }
export interface VoiceWorkerObserver {
  /** Actual HTTP send, including busy retries. */
  onRequest?: () => void;
  /** First validated answer text; streaming adapters may call before completion. */
  onFirstText?: () => void;
  /** Must interrupt already queued/playing speech before consumer pulls again. */
  onError?: (error: unknown) => void;
  /** Explicit terminal done validated; independent of remaining local playout. */
  onComplete?: () => void;
}
export interface VoiceWorkerGateway {
  turn(input: VoiceWorkerTurn, signal: AbortSignal, observer?: VoiceWorkerObserver): Promise<string>;
  stream?(input: VoiceWorkerTurn, signal: AbortSignal, observer?: VoiceWorkerObserver): AsyncIterable<string>;
  cancel(input: Pick<VoiceWorkerTurn, 'turnId' | 'revision'>): Promise<void>;
}
export interface VoiceSpeechHandle {
  readonly id: string;
  interrupt(force?: boolean): unknown;
  waitForPlayout(): Promise<void>;
}
export interface VoiceWorkerClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
const clock: VoiceWorkerClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer),
};

export interface VoiceWorkerTiming {
  /** VAD listening transition observed by worker; NOT waveform-accurate speech end. */
  lastUserSpeechAt?: number;
  finalAt?: number;
  committedAt: number;
  firstRequestAt?: number;
  firstTextAt?: number;
  firstSentenceAt?: number;
  ttsQueuedAt?: number;
  firstServerAudioAt?: number;
  playoutFinishedAt?: number;
}

interface ActiveTurn {
  input: VoiceWorkerTurn;
  source: VoiceInputRevision;
  abort: AbortController;
  deadline?: ReturnType<typeof setTimeout>;
  deadlineAt: number;
  answer?: string;
  speech?: VoiceSpeechHandle;
  started: boolean;
  timing: VoiceWorkerTiming;
  requestAttempt: number;
  streaming?: boolean;
  sentenceDone?: () => void;
}

export class VoiceWorkerController {
  readonly input = new VoiceTurnOrchestrator();
  private readonly clock: VoiceWorkerClock;
  private readonly quietMs: number;
  private quietUntil = 0;
  private speaking = false;
  private lastUserSpeechAt?: number;
  private finalAt?: number;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private active?: ActiveTurn;
  private readonly cancellations = new Set<Promise<void>>();
  private closePromise?: Promise<void>;
  private uiSeq = 0;

  constructor(private readonly options: {
    gateway: VoiceWorkerGateway;
    say: (text: string) => VoiceSpeechHandle;
    clock?: VoiceWorkerClock;
    quietMs?: number;
    deadlineMs?: number;
    maxRequestAttempts?: number;
    makeTurnId?: () => string;
    onUiEvent?: (event: VoiceWorkerUiEvent) => void;
    onEvent?: (stage: string, details?: Record<string, unknown>) => void;
  }) {
    this.clock = options.clock ?? clock;
    this.quietMs = options.quietMs ?? VoiceTurnOrchestrator.DEFAULT_SILENCE_MS;
  }

  onFinalTranscript(transcript: string): void {
    if (this.closed || !transcript.trim()) return;
    this.finalAt = this.clock.now();
    const result = this.input.appendFinalTranscript(transcript, Boolean(this.active));
    this.invalidateActive();
    this.quietUntil = this.clock.now() + this.quietMs;
    this.ui({ kind: 'input', text: transcript, final: true, revision: result.revision });
    this.emit('stt_final', { revision: result.revision, transcriptLength: transcript.length, finalAt: this.finalAt,
      lastUserSpeechAt: this.lastUserSpeechAt, speechEndBasis: 'vad_state_observed' });
    this.schedule();
  }

  onInterimTranscript(transcript: string): void {
    if (this.closed || !transcript.trim()) return;
    // Display only. Never appended to input segments or sent to the backend.
    this.ui({ kind: 'input', text: transcript, final: false, revision: this.input.getRevision() + 1 });
  }

  onUserState(speaking: boolean): void {
    if (this.closed) return;
    const wasSpeaking = this.speaking;
    this.speaking = speaking;
    if (!speaking && wasSpeaking) {
      this.lastUserSpeechAt = this.clock.now();
      this.emit('last_user_speech', { lastUserSpeechAt: this.lastUserSpeechAt,
        speechEndBasis: 'vad_state_observed', revision: this.input.getRevision() });
      if (this.active) this.active.timing.lastUserSpeechAt = this.lastUserSpeechAt;
    }
    this.quietUntil = this.clock.now() + this.quietMs;
    if (speaking) {
      this.input.markUserSpeaking();
      // Stop queued as well as playing speech. A not-yet-heard cached answer can
      // resume after quiet if no new final confirms input; never replay heard audio.
      const active = this.active;
      if (active?.streaming && (active.speech || active.started || active.answer)) {
        this.invalidateActive();
      } else if (active?.speech) {
        const speech = active.speech;
        this.uiSpeech('sentence', active, speech, 'interrupted');
        active.speech = undefined;
        this.interrupt(speech);
        this.cancel(active);
        if (active.started) this.active = undefined;
      }
    }
    this.schedule();
  }

  /** SDK AgentStateChanged('speaking'): server output started, NOT browser heard. */
  onPlaybackStarted(speechId: string): void {
    const active = this.active;
    if (!active?.speech || active.speech.id !== speechId || !this.isCurrent(active)) return;
    if (this.speaking) {
      const speech = active.speech;
      this.uiSpeech('sentence', active, speech, 'interrupted');
      active.speech = undefined;
      this.interrupt(speech);
      this.cancel(active);
      this.schedule();
      return;
    }
    this.uiSpeech('sentence', active, active.speech, 'speaking');
    if (active.started) return;
    active.started = true;
    active.timing.firstServerAudioAt = this.clock.now();
    this.input.markSpeaking();
    this.emitTurn('first_server_audio', active, { speechId, audioEvidence: 'sdk_server_output_not_client_playback' });
  }

  /** Diagnostic only: SDK endpointing is not the worker execution permit. */
  onSdkEndOfTurn(): void {
    this.emit('sdk_end_of_turn', { revision: this.input.getRevision(),
      finalAt: this.finalAt, lastUserSpeechAt: this.lastUserSpeechAt });
  }

  get speechId(): string | undefined { return this.active?.speech?.id; }
  get canExecute(): boolean {
    return !this.closed && !this.speaking && this.clock.now() >= this.quietUntil;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.clearTimer();
    this.invalidateActive();
    this.input.clear();
    this.ui({ kind: 'reset' });
    // Shutdown callback must allow the independent, deadline-bound cancel HTTP
    // request to leave the worker before the job process exits.
    this.closePromise = Promise.allSettled([...this.cancellations]).then(() => undefined);
    return this.closePromise;
  }

  private ui(event: Omit<VoiceWorkerUiEvent, 'v' | 'seq'>): void {
    // Display truncation only; original STT and spoken answer remain untouched.
    // 2k UTF-16 units keeps JSON below the reliable packet/receiver 16KiB bound,
    // even when every control character needs a six-byte JSON escape.
    const bounded = event.text === undefined ? event : { ...event, text: event.text.slice(0, 2000) };
    try { this.options.onUiEvent?.({ v: 1, seq: ++this.uiSeq, ...bounded }); }
    catch { this.emit('voice_ui_publish_failed'); }
  }
  private uiSpeech(kind: 'sentence' | 'waiting', active: ActiveTurn, handle: VoiceSpeechHandle,
    state: VoiceWorkerUiEvent['state'], text = active.answer): void {
    this.ui({ kind, turnId: active.input.turnId, revision: active.input.revision,
      text, speechId: handle.id, state });
  }
  private emit(stage: string, details?: Record<string, unknown>): void {
    this.options.onEvent?.(stage, { ...details, atMs: this.clock.now() });
  }
  private emitTurn(stage: string, active: ActiveTurn, details?: Record<string, unknown>): void {
    const t = active.timing;
    this.emit(stage, { turnId: active.input.turnId, revision: active.input.revision,
      ...t, ...details,
      finalToCommitMs: t.finalAt === undefined ? undefined : t.committedAt - t.finalAt,
      requestToFirstTextMs: t.firstTextAt === undefined || t.firstRequestAt === undefined
        ? undefined : t.firstTextAt - t.firstRequestAt,
      textToFirstSentenceMs: t.firstSentenceAt === undefined || t.firstTextAt === undefined
        ? undefined : t.firstSentenceAt - t.firstTextAt,
      queuedToServerAudioMs: t.firstServerAudioAt === undefined || t.ttsQueuedAt === undefined
        ? undefined : t.firstServerAudioAt - t.ttsQueuedAt,
      observedSpeechEndToServerAudioMs: t.lastUserSpeechAt === undefined || t.firstServerAudioAt === undefined
        ? undefined : t.firstServerAudioAt - t.lastUserSpeechAt,
    });
  }
  private firstText(active: ActiveTurn): void {
    if (!this.isCurrent(active) || active.timing.firstTextAt !== undefined) return;
    active.timing.firstTextAt = this.clock.now();
    this.emitTurn('first_text', active);
  }
  private clearTimer(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }
  private isCurrent(active: ActiveTurn): boolean {
    return !this.closed && this.active === active && !active.abort.signal.aborted
      && this.input.getRevision() === active.input.revision;
  }
  private interrupt(speech: VoiceSpeechHandle): void {
    if (this.active?.speech === speech) this.uiSpeech('sentence', this.active, speech, 'interrupted');
    try { speech.interrupt(true); } catch { this.emit('tts_interrupt_failed'); }
  }
  private cancel(active: ActiveTurn): void {
    // Separate request/signal: aborting the turn transport must not abort cancellation.
    const pending = Promise.resolve().then(() => this.options.gateway.cancel(active.input))
      .then(() => this.emit('tower_cancel_acknowledged', { turnId: active.input.turnId }))
      .catch(() => this.emit('tower_cancel_unconfirmed', { turnId: active.input.turnId }));
    this.cancellations.add(pending);
    void pending.finally(() => this.cancellations.delete(pending));
  }
  private invalidateActive(): void {
    const active = this.active;
    if (!active) return;
    if (active.speech) this.uiSpeech('sentence', active, active.speech, 'interrupted');
    this.active = undefined; // late completion cannot affect the next revision
    active.abort.abort();
    if (active.deadline !== undefined) this.clock.clearTimeout(active.deadline);
    if (active.speech) this.interrupt(active.speech);
    this.cancel(active);
  }

  /** The only execution/output permit. Completions re-arm this timer, never loop. */
  private schedule(): void {
    this.clearTimer();
    if (this.closed || this.speaking) return;
    const hasWork = this.input.hasPendingTranscript()
      || (this.active?.answer !== undefined && !this.active.speech);
    if (!hasWork) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      if (this.closed || this.speaking) return;
      if (this.clock.now() < this.quietUntil) { this.schedule(); return; }
      if (this.input.hasPendingTranscript()) this.dispatch();
      else if (this.active?.answer !== undefined && !this.active.speech) this.play(this.active);
    }, Math.max(0, this.quietUntil - this.clock.now()));
  }

  private dispatch(): void {
    if (this.active) return;
    const source = this.input.takeInput();
    const active: ActiveTurn = {
      source,
      input: { transcript: source.transcript, revision: source.revision,
        turnId: (this.options.makeTurnId ?? randomUUID)() },
      abort: new AbortController(), started: false, requestAttempt: 0,
      deadlineAt: this.clock.now() + (this.options.deadlineMs ?? VOICE_TURN_DEADLINE_MS),
      timing: { lastUserSpeechAt: this.lastUserSpeechAt, finalAt: this.finalAt, committedAt: this.clock.now() },
    };
    this.active = active;
    active.deadline = this.clock.setTimeout(() => {
      if (!this.isCurrent(active)) return;
      this.emit('tower_deadline', { turnId: active.input.turnId });
      this.fail(active, new VoiceWorkerHttpError('VOICE_DEADLINE', 504));
    }, Math.max(0, active.deadlineAt - this.clock.now()));
    this.emitTurn('input_committed', active);
    const observer: VoiceWorkerObserver = {
      onRequest: () => {
        if (!this.isCurrent(active)) throw new DOMException('Voice turn is no longer current', 'AbortError');
        if (this.clock.now() >= active.deadlineAt) throw new VoiceWorkerHttpError('VOICE_DEADLINE', 504);
        if (active.requestAttempt >= (this.options.maxRequestAttempts ?? VOICE_MAX_REQUEST_ATTEMPTS)) {
          throw new VoiceWorkerHttpError('VOICE_BUSY_EXHAUSTED', 409);
        }
        active.timing.firstRequestAt ??= this.clock.now();
        this.emitTurn('tower_request', active, { attempt: ++active.requestAttempt });
      },
      onFirstText: () => this.firstText(active),
      onError: (error) => this.fail(active, error),
      onComplete: () => {
        if (!this.isCurrent(active)) return;
        this.clearDeadline(active);
        this.emitTurn('tower_response_complete', active);
      },
    };
    if (this.options.gateway.stream) {
      active.streaming = true;
      void this.consumeStream(active, observer).catch((error) => this.fail(active, error));
      return;
    }
    // Completion-only adapter: do not claim early text/audio for unsupported providers.
    void Promise.resolve().then(() => {
      if (!this.isCurrent(active)) return undefined;
      return this.options.gateway.turn(active.input, active.abort.signal, observer);
    }).then((answer) => {
      if (!this.isCurrent(active) || answer === undefined) return;
      this.clearDeadline(active);
      if (answer.trim()) this.firstText(active);
      active.answer = normalizeSpokenAnswer(answer);
      if (!active.answer) throw new VoiceWorkerHttpError('VOICE_EMPTY_ANSWER', 502);
      this.emitTurn('tower_done', active, { mode: 'completion_fallback' });
      this.schedule();
    }).catch((error) => this.fail(active, error));
  }

  private clearDeadline(active: ActiveTurn): void {
    if (active.deadline !== undefined) this.clock.clearTimeout(active.deadline);
    active.deadline = undefined;
  }

  private fail(active: ActiveTurn, error: unknown): void {
    if (!this.isCurrent(active)) return;
    this.emitTurn('tower_failed', active, {
      code: error instanceof VoiceWorkerHttpError ? error.code : 'VOICE_TRANSPORT_ERROR',
      status: error instanceof VoiceWorkerHttpError ? error.status : undefined,
    });
    this.invalidateActive();
    const code = error instanceof VoiceWorkerHttpError ? error.code : 'VOICE_TRANSPORT_ERROR';
    const text = code === 'VOICE_RECOVERY_REQUIRED'
      ? '이전 음성 실행을 복구해야 합니다. 복구 후 다시 시도해 주세요.'
      : code === 'VOICE_BUSY_EXHAUSTED'
      ? '이 대화의 이전 작업이 끝나지 않아 답변을 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.'
      : code === 'VOICE_DEADLINE'
        ? '답변 대기 시간이 초과되어 중단했습니다. 다시 시도해 주세요.'
        : '음성 답변을 완료하지 못했습니다. 다시 시도해 주세요.';
    this.ui({ kind: 'error', turnId: active.input.turnId, revision: active.input.revision, code, text, final: true });
    this.schedule();
  }

  private async consumeStream(active: ActiveTurn, observer: VoiceWorkerObserver): Promise<void> {
    const deltas = this.options.gateway.stream!(active.input, active.abort.signal, observer);
    for await (const sentence of voiceSentenceStream({ deltas, signal: active.abort.signal,
      isCurrent: () => this.isCurrent(active) })) {
      if (!this.isCurrent(active)) return;
      active.timing.firstSentenceAt ??= this.clock.now();
      this.emitTurn('sentence_ready', active);
      // Only one sentence can be admitted to SDK at a time. Await playout before
      // pulling the next delta; VAD/final/close abort rejects this waiter.
      await new Promise<void>((resolve, reject) => {
        const abort = () => { cleanup(); reject(active.abort.signal.reason ?? new DOMException('Aborted', 'AbortError')); };
        const cleanup = () => {
          active.abort.signal.removeEventListener('abort', abort);
          active.sentenceDone = undefined;
        };
        active.sentenceDone = () => { cleanup(); resolve(); };
        active.abort.signal.addEventListener('abort', abort, { once: true });
        active.answer = sentence;
        this.schedule();
      });
    }
    if (!this.isCurrent(active)) return;
    this.clearDeadline(active);
    if (active.timing.firstSentenceAt === undefined) throw new VoiceWorkerHttpError('VOICE_EMPTY_ANSWER', 502);
    this.emitTurn('tower_done', active, { mode: 'answer_stream' });
    this.active = undefined;
    this.input.markPlaybackFinished();
  }

  private play(active: ActiveTurn): void {
    if (!this.isCurrent(active) || this.speaking || !active.answer) return;
    try {
      const speech = this.options.say(active.answer);
      active.speech = speech;
      active.timing.ttsQueuedAt ??= this.clock.now();
      this.emitTurn('tts_queued', active, { speechId: speech.id });
      this.uiSpeech('sentence', active, speech, 'queued');
      void speech.waitForPlayout().then(() => {
        if (!this.isCurrent(active) || active.speech !== speech) return;
        this.uiSpeech('sentence', active, speech, 'completed');
        if (!active.streaming) this.active = undefined;
        this.input.markPlaybackFinished();
        active.timing.playoutFinishedAt = this.clock.now();
        this.emitTurn('playout_finished', active, { speechId: speech.id });
        if (active.streaming) {
          active.speech = undefined; active.answer = undefined; active.sentenceDone?.();
        }
        this.schedule();
      }).catch(() => {
        if (!this.isCurrent(active) || active.speech !== speech) return;
        this.emit('tts_failed', { turnId: active.input.turnId });
        this.fail(active, new VoiceWorkerHttpError('VOICE_TTS_FAILED', 502));
      });
    } catch {
      this.emit('tts_failed', { turnId: active.input.turnId });
      this.fail(active, new VoiceWorkerHttpError('VOICE_TTS_FAILED', 502));
    }
  }
}

export class VoiceWorkerHttpError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(`Voice backend failed (${status}, ${code})`);
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); return; }
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => {
      clearTimeout(timer); cleanup(); reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** One immutable wall-clock budget per logical HTTP turn, never reset by BUSY. */
function createVoiceRequestBudget(parent: AbortSignal, options: { deadlineMs?: number; maxRequestAttempts?: number }) {
  const abort = new AbortController();
  const deadlineAt = Date.now() + (options.deadlineMs ?? VOICE_TURN_DEADLINE_MS);
  const timer = setTimeout(() => abort.abort(new VoiceWorkerHttpError('VOICE_DEADLINE', 504)),
    Math.max(0, deadlineAt - Date.now()));
  const signal = AbortSignal.any([parent, abort.signal]);
  let attempts = 0;
  return {
    signal,
    admit() {
      signal.throwIfAborted();
      if (Date.now() >= deadlineAt) throw new VoiceWorkerHttpError('VOICE_DEADLINE', 504);
      if (attempts >= (options.maxRequestAttempts ?? VOICE_MAX_REQUEST_ATTEMPTS)) {
        throw new VoiceWorkerHttpError('VOICE_BUSY_EXHAUSTED', 409);
      }
      attempts += 1;
    },
    close: () => clearTimeout(timer),
  };
}

/** baseUrl is the backend API base, e.g. http://localhost:32355/api. */
export function createVoiceWorkerHttpGateway(options: {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  busyBackoffMs?: number;
  cancelDeadlineMs?: number;
  deadlineMs?: number;
  maxRequestAttempts?: number;
  /** Read the scheduler's VAD/quiet permit before EVERY transport retry. */
  canStart?: () => boolean;
}): VoiceWorkerGateway {
  const base = new URL(options.baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password
    || base.search || base.hash) throw new Error('Invalid voice backend API URL');
  const baseUrl = base.href.replace(/\/$/, '');
  const fetcher = options.fetch ?? fetch;
  const post = (path: string, input: object, signal: AbortSignal, streaming = false) => fetcher(`${baseUrl}/voice/internal/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(streaming ? { Accept: 'application/x-ndjson' } : {}) },
    body: JSON.stringify({ token: options.token, ...input }), signal,
  });
  return {
    async turn(input, signal, observer) {
      const budget = createVoiceRequestBudget(signal, options);
      signal = budget.signal;
      try {
      // A bounded, abortable transport retry is not an execution scheduler. The
      // same immutable turnId/revision is used on every VOICE_BUSY retry.
      for (;;) {
        signal.throwIfAborted();
        if (options.canStart && !options.canStart()) {
          await abortableDelay(options.busyBackoffMs ?? 500, signal);
          continue;
        }
        budget.admit();
        observer?.onRequest?.();
        const response = await post('turn', input, signal);
        const body = await response.json() as {
          assistantText?: string; code?: string; turnId?: string; revision?: number;
        };
        signal.throwIfAborted();
        if (response.status === 409 && body.code === 'VOICE_BUSY') {
          await abortableDelay(options.busyBackoffMs ?? 500, signal);
          continue;
        }
        if (!response.ok) throw new VoiceWorkerHttpError(body.code ?? 'VOICE_HTTP_ERROR', response.status);
        if (body.turnId !== input.turnId || body.revision !== input.revision
          || typeof body.assistantText !== 'string') {
          throw new VoiceWorkerHttpError('VOICE_INVALID_RESPONSE', response.status);
        }
        if (body.assistantText.trim()) observer?.onFirstText?.();
        return body.assistantText;
      }
      } finally { budget.close(); }
    },
    async *stream(input, signal, observer) {
      const budget = createVoiceRequestBudget(signal, options);
      signal = budget.signal;
      try {
      for (;;) {
        signal.throwIfAborted();
        if (options.canStart && !options.canStart()) {
          await abortableDelay(options.busyBackoffMs ?? 500, signal); continue;
        }
        budget.admit();
        observer?.onRequest?.();
        const response = await post('turn', input, signal, true);
        if (!response.ok) {
          const body = await response.json() as { code?: string };
          if (response.status === 409 && body.code === 'VOICE_BUSY') {
            await abortableDelay(options.busyBackoffMs ?? 500, signal); continue;
          }
          throw new VoiceWorkerHttpError(body.code ?? 'VOICE_HTTP_ERROR', response.status);
        }
        if (!response.headers.get('content-type')?.includes('application/x-ndjson')) {
          throw new VoiceWorkerHttpError('VOICE_STREAM_CONTENT_TYPE', response.status);
        }
        let first = true;
        for await (const text of monitorVoiceAnswerStream(readVoiceAnswerStream(response, input, signal), signal, {
          ...observer, onComplete: () => { budget.close(); observer?.onComplete?.(); },
        })) {
          if (first && text.trim()) { first = false; observer?.onFirstText?.(); }
          yield text;
        }
        return;
      }
      } finally { budget.close(); }
    },
    async cancel(input) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), options.cancelDeadlineMs ?? 5_000);
      try {
        const response = await post('cancel', { turnId: input.turnId, revision: input.revision }, abort.signal);
        if (!response.ok) throw new VoiceWorkerHttpError('VOICE_CANCEL_FAILED', response.status);
        const body = await response.json() as { accepted?: boolean; turnId?: string; revision?: number };
        if (body.accepted !== true || body.turnId !== input.turnId || body.revision !== input.revision) {
          throw new VoiceWorkerHttpError('VOICE_CANCEL_UNCONFIRMED', response.status);
        }
      } finally { clearTimeout(timer); }
    },
  };
}


/** Decode bounded UTF-8 NDJSON; EOF without explicit terminal success is failure. */
export async function* readVoiceAnswerStream(
  response: Response, input: Pick<VoiceWorkerTurn, 'turnId' | 'revision'>, signal: AbortSignal,
): AsyncGenerator<string> {
  if (!response.body) throw new VoiceWorkerHttpError('VOICE_STREAM_EMPTY', 502);
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const limit = 1_048_576;
  let buffer = '';
  let prefix = '';
  let seq = 0;
  let lastLine = '';
  let terminal = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const invalid = (code: string): never => { throw new VoiceWorkerHttpError(code, 502); };
  const consume = (line: string): string | undefined => {
    if (!line.trim()) return;
    let event: any;
    try { event = JSON.parse(line); } catch { return invalid('VOICE_STREAM_JSON'); }
    if (!event || event.turnId !== input.turnId || event.revision !== input.revision) {
      return invalid('VOICE_STREAM_IDENTITY');
    }
    // Only an exact retransmission of the last event is idempotent. Older/out-of-order
    // events and a changed payload under the same seq are protocol failures.
    if (event.seq === seq && seq > 0 && line === lastLine) return;
    if (!Number.isSafeInteger(event.seq) || event.seq !== seq + 1) return invalid('VOICE_STREAM_SEQUENCE');
    seq = event.seq; lastLine = line;
    if (event.type === 'answer_delta') {
      if (event.channel !== 'final_answer' || typeof event.text !== 'string') return invalid('VOICE_STREAM_CHANNEL');
      prefix += event.text;
      if (prefix.length > limit) return invalid('VOICE_STREAM_LIMIT');
      return event.text;
    }
    if (event.type === 'done') {
      if (typeof event.assistantText !== 'string' || !event.assistantText.startsWith(prefix)) {
        return invalid('VOICE_STREAM_FINAL_CONFLICT');
      }
      if (event.assistantText.length > limit) return invalid('VOICE_STREAM_LIMIT');
      terminal = true;
      // Terminal full text may extend early deltas; never replay the emitted prefix.
      return event.assistantText.slice(prefix.length);
    }
    if (event.type === 'error') {
      throw new VoiceWorkerHttpError(typeof event.code === 'string' ? event.code : 'VOICE_STREAM_ERROR',
        Number.isInteger(event.status) ? event.status : 502);
    }
    return invalid('VOICE_STREAM_EVENT');
  };
  try {
    for (;;) {
      signal.throwIfAborted();
      const result = await reader.read();
      signal.throwIfAborted();
      buffer += decoder.decode(result.value, { stream: !result.done });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line.length > limit) invalid('VOICE_STREAM_LIMIT');
        const text = consume(line);
        if (text) yield text;
        if (terminal) return;
      }
      if (buffer.length > limit) invalid('VOICE_STREAM_LIMIT');
      if (result.done) {
        const text = consume(buffer);
        if (text) yield text;
        if (!terminal) invalid('VOICE_STREAM_TERMINAL_MISSING');
        return;
      }
    }
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}


/**
 * Read terminal errors while SDK playout blocks sentence consumption. The bounded
 * mailbox absorbs short provider bursts; overload is fail-closed, not unbounded
 * buffering or a hidden replay. SDK admission remains one sentence at a time.
 */
async function* monitorVoiceAnswerStream(
  source: AsyncIterable<string>, signal: AbortSignal, observer?: VoiceWorkerObserver,
): AsyncGenerator<string> {
  const queue: string[] = [];
  let chars = 0;
  let complete = false;
  let failure: unknown;
  let wake: (() => void) | undefined;
  const notify = () => { wake?.(); wake = undefined; };
  const pump = (async () => {
    try {
      for await (const text of source) {
        signal.throwIfAborted();
        if (chars + text.length > 65_536 || queue.length >= 256) {
          throw new VoiceWorkerHttpError('VOICE_STREAM_BACKPRESSURE_LIMIT', 502);
        }
        queue.push(text); chars += text.length; notify();
      }
      observer?.onComplete?.();
    } catch (error) {
      failure = error; queue.length = 0; chars = 0;
      observer?.onError?.(error);
    } finally { complete = true; notify(); }
  })();
  try {
    for (;;) {
      signal.throwIfAborted();
      if (failure) throw failure;
      const text = queue.shift();
      if (text !== undefined) { chars -= text.length; yield text; continue; }
      if (complete) return;
      await new Promise<void>((resolve) => { wake = resolve; });
    }
  } finally {
    queue.length = 0;
    // The controller owns abort and transport cancellation. Pump catches its own
    // errors, so cleanup never creates a detached unhandled rejection.
    void pump;
  }
}
