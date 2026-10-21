/** Ephemeral, bounded voice captions. Never persisted as chat history. */
export const VOICE_UI_TOPIC = 'tower.voice.ui.v1';
export const VOICE_UI_MAX_BYTES = 16_384;
export const VOICE_UI_MAX_TEXT = 4_000;
export const VOICE_UI_MAX_SENTENCES = 12;
export type VoiceSentenceState = 'queued' | 'speaking' | 'completed' | 'interrupted';
export interface VoiceUiMessage {
  v: 1;
  seq: number;
  kind: 'input' | 'sentence' | 'waiting' | 'reset';
  turnId?: string;
  revision?: number;
  text?: string;
  final?: boolean;
  speechId?: string;
  state?: VoiceSentenceState;
}
export interface VoiceCaptionSentence {
  turnId: string;
  revision: number;
  speechId: string;
  text: string;
  state: VoiceSentenceState;
}
export interface VoiceTranscriptState {
  senderIdentity: string | null;
  seq: number;
  revision: number;
  input: { text: string; final: boolean; revision: number } | null;
  sentences: VoiceCaptionSentence[];
  waiting: boolean;
}
export const initialVoiceTranscriptState: VoiceTranscriptState = {
  senderIdentity: null, seq: -1, revision: -1, input: null, sentences: [], waiting: false,
};
const fields = new Set(['v', 'seq', 'kind', 'turnId', 'revision', 'text', 'final', 'speechId', 'state']);
const isInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;

export function parseVoiceUiMessage(payload: Uint8Array): VoiceUiMessage | null {
  if (!payload.byteLength || payload.byteLength > VOICE_UI_MAX_BYTES) return null;
  try {
    const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const value = data as Record<string, unknown>;
    if (Object.keys(value).some((key) => !fields.has(key)) || value.v !== 1 || !isInteger(value.seq)) return null;
    if (!['input', 'sentence', 'waiting', 'reset'].includes(value.kind as string)) return null;
    if (value.revision !== undefined && !isInteger(value.revision)) return null;
    if (value.turnId !== undefined && !isId(value.turnId)) return null;
    if (value.speechId !== undefined && !isId(value.speechId)) return null;
    if (value.text !== undefined && (typeof value.text !== 'string' || value.text.length > VOICE_UI_MAX_TEXT)) return null;
    if (value.final !== undefined && typeof value.final !== 'boolean') return null;
    if (value.state !== undefined && !['queued', 'speaking', 'completed', 'interrupted'].includes(value.state as string)) return null;
    if (value.kind === 'input' && (!isInteger(value.revision) || typeof value.text !== 'string' || typeof value.final !== 'boolean')) return null;
    if (value.kind === 'sentence' && (!isInteger(value.revision) || !isId(value.turnId) || !isId(value.speechId) || value.state === undefined)) return null;
    if (value.kind === 'waiting' && !isInteger(value.revision)) return null;
    return value as unknown as VoiceUiMessage;
  } catch { return null; }
}

export type VoiceTranscriptAction = { type: 'clear' } | {
  type: 'receive'; message: VoiceUiMessage; senderIdentity: string; isAgent: boolean;
};
export function voiceTranscriptReducer(state: VoiceTranscriptState, action: VoiceTranscriptAction): VoiceTranscriptState {
  if (action.type === 'clear') return initialVoiceTranscriptState;
  const { message, senderIdentity, isAgent } = action;
  if (!isAgent || !isId(senderIdentity) || (state.senderIdentity && state.senderIdentity !== senderIdentity)) return state;
  if (message.seq <= state.seq || (message.revision !== undefined && message.revision < state.revision)) return state;
  const revision = message.revision ?? state.revision;
  const next = { ...state, senderIdentity, seq: message.seq, revision };
  if (message.kind === 'reset') return { ...initialVoiceTranscriptState, senderIdentity, seq: message.seq, revision };
  if (message.kind === 'input') {
    if (state.input?.revision === revision && state.input.final && !message.final) return state;
    return { ...next, input: { text: message.text!, final: message.final!, revision }, waiting: false,
      sentences: revision > state.revision ? state.sentences.map((sentence) => (
        sentence.state === 'queued' || sentence.state === 'speaking' ? { ...sentence, state: 'interrupted' as const } : sentence
      )) : state.sentences };
  }
  if (message.kind === 'waiting') return { ...next, waiting: true };
  const index = state.sentences.findIndex((sentence) => sentence.speechId === message.speechId
    && sentence.turnId === message.turnId && sentence.revision === revision);
  const prior = state.sentences[index];
  if (prior && (prior.state === 'completed' || prior.state === 'interrupted')) return state;
  if (prior?.state === 'speaking' && message.state === 'queued') return state;
  const text = message.text ?? prior?.text;
  if (!text) return next;
  const sentence: VoiceCaptionSentence = { turnId: message.turnId!, revision, speechId: message.speechId!, text, state: message.state! };
  const sentences = [...state.sentences];
  if (index >= 0) sentences[index] = sentence;
  else sentences.push(sentence);
  return { ...next, waiting: false, sentences: sentences.slice(-VOICE_UI_MAX_SENTENCES) };
}
