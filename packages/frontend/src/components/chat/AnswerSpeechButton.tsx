import { finalizeDictationForSend } from './dictation-submit';
import { eligibleSpeechMessage, useSpeechSession } from './answer-speech-session';
import { getAnswerSpeechPlayer, primeAnswerSpeechPlayer } from './answer-speech-player';
import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '../../stores/chat-store';
import { useSessionStore } from '../../stores/session-store';
import { useAnswerVoice } from './AnswerVoiceToggle';
import { activeSentence, renderedSpeechText } from './answer-speech-highlight';
import { speechChunks, stableSpeechPrefix } from './answer-speech-stream';

type Packet = { audio_base64: string; alignment: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] } };
/** One active playback owner. Requests are bounded to current + one lookahead. */
export function AnswerSpeechButton({ text, messageId, completedAt, live = false, messageTimestamp }: { text: string; messageId: string; completedAt?: number; live?: boolean; messageTimestamp: number }) {
  const sessionId = useSessionStore(s => s.activeSessionId);
  const enabledAt = useAnswerVoice(s => sessionId ? s.enabledAt[sessionId] || 0 : 0);
  const root = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'playing' | 'paused'>('idle');
  const [error, setError] = useState('');
  const [sentence, setSentence] = useState<string | null>(null);
  const run = useRef<{ controller: AbortController; chunks: string[]; index: number; committed: string; audio: HTMLAudioElement | null; pending: Map<number, Promise<Packet>>; busy: boolean; sessionId: string } | null>(null);
  const eligible = useRef(false);
  const interrupted = useRef(false);
  const key = `${sessionId}:${messageId}`;
  const recording = useSpeechSession(s => !!(sessionId && s.recording[sessionId]));
  const owner = useSpeechSession(s => s.owner);
  const recordingHold = useRef(false);
  const questionCutoff = useRef<string | null>(null);
  function stop() {
    const r = run.current; run.current = null;
    if (r) { r.controller.abort(); r.audio?.pause(); if (r.audio) URL.revokeObjectURL(r.audio.src); }
    useSpeechSession.getState().release(key);
    setState('idle'); setSentence(null);
  }
  useEffect(() => {
    const interrupt = () => { interrupted.current = true; eligible.current = false; stop(); };
    const hold = () => { recordingHold.current = true; stop(); };
    window.addEventListener('tower-speech-recording', hold);
    const question = (event: Event) => {
      if ((event as CustomEvent).detail?.sessionId !== sessionId) return;
      const body = root.current?.closest<HTMLElement>('[data-answer-body]');
      questionCutoff.current = body ? renderedSpeechText(body) || text : text;
      interrupted.current = false; recordingHold.current = false; eligible.current = false; stop();
      useSpeechSession.getState().commit(key, questionCutoff.current);
    };
    window.addEventListener('tower-speech-question', question);
    const visibility = () => { if (document.hidden) interrupt(); };
    window.addEventListener('tower-speech-stop', interrupt);
    document.addEventListener('visibilitychange', visibility);
    return () => { window.removeEventListener('tower-speech-question', question); window.removeEventListener('tower-speech-recording', hold); window.removeEventListener('tower-speech-stop', interrupt); document.removeEventListener('visibilitychange', visibility); stop(); };
  }, [sessionId, messageId]);
  useEffect(() => {
    const body = root.current?.closest<HTMLElement>('[data-answer-body]');
    if (!body || !sentence) return;
    const registry = (CSS as any).highlights;
    const HighlightClass = (window as any).Highlight;
    if (!registry || !HighlightClass) return;
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, { acceptNode: node => node.parentElement?.closest('[data-speech-prose]') && !node.parentElement?.closest('pre,table') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    const all = nodes.map(n => n.data).join(''); const start = all.indexOf(sentence);
    if (start < 0) return;
    const range = document.createRange(); let offset = 0; let begun = false;
    for (const node of nodes) {
      if (!begun && start < offset + node.length) { range.setStart(node, start - offset); begun = true; }
      if (begun && start + sentence.length <= offset + node.length) { range.setEnd(node, start + sentence.length - offset); break; }
      offset += node.length;
    }
    registry.set('answer-speech', new HighlightClass(range));
    return () => registry.delete('answer-speech');
  }, [sentence, text]);
  function request(r: NonNullable<typeof run.current>, index: number): Promise<Packet> {
    const existing = r.pending.get(index); if (existing) return existing;
    const token = localStorage.getItem('token');
    const promise = fetch(`/api/sessions/${encodeURIComponent(r.sessionId)}/answer-speech`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ text: r.chunks[index] }), signal: r.controller.signal,
    }).then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error || '음성 생성에 실패했습니다.'); return data as Packet; });
    void promise.catch(() => {}); r.pending.set(index, promise); return promise;
  }
  async function pump() {
    const r = run.current;
    if (!r || r.busy || r.audio || r.index >= r.chunks.length) return;
    r.busy = true; setState('loading');
    try {
      const packet = await request(r, r.index);
      if (run.current !== r || r.controller.signal.aborted || useSessionStore.getState().activeSessionId !== r.sessionId) return;
      const bytes = Uint8Array.from(atob(packet.audio_base64), c => c.charCodeAt(0));
      const player = getAnswerSpeechPlayer();
      player.playbackRate = 1.2;
      player.preservesPitch = true;
      player.onended = null; player.onerror = null; player.ontimeupdate = null;
      player.src = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
      r.audio = player;
      player.ontimeupdate = () => { if (run.current === r) setSentence(activeSentence(packet.alignment, player.currentTime)); };
      player.onended = () => {
        if (run.current !== r) return;
        useSpeechSession.getState().commit(key, (useSpeechSession.getState().consumed[key] || '') + r.chunks[r.index]);
        URL.revokeObjectURL(player.src); r.audio = null; r.pending.delete(r.index); r.index++; r.busy = false;
        if (r.index >= r.chunks.length) useSpeechSession.getState().release(key);
        if (run.current === r) { setSentence(null); setState('idle'); void pump(); }
      };
      player.onerror = () => { if (run.current === r) { URL.revokeObjectURL(player.src); r.audio = null; r.busy = false; setState('idle'); setError('재생에 실패했습니다. 다시 읽기를 눌러 주세요.'); } };
      try { await player.play(); if (run.current === r) setState('playing'); }
      catch { if (run.current === r) { setState('paused'); setError('이어서 읽기를 눌러 음성을 재생해 주세요.'); } }
      if (run.current === r && r.index + 1 < r.chunks.length) void request(r, r.index + 1);
    } catch (e) {
      if (run.current === r && !r.controller.signal.aborted) { r.pending.delete(r.index); r.busy = false; setState('idle'); setError(e instanceof Error ? e.message : '음성 요청에 실패했습니다.'); }
    }
  }
  function begin(automatic = false) {
    if (!sessionId) return;
    if (!automatic) {
      window.dispatchEvent(new Event('tower-speech-stop'));
      window.dispatchEvent(new Event('tower-dictation-stop'));
      useSpeechSession.getState().commit(key, '');
    }
    useSpeechSession.getState().claim(key);
    run.current = { controller: new AbortController(), chunks: [], index: 0, committed: automatic ? useSpeechSession.getState().consumed[key] || '' : '', audio: null, pending: new Map(), busy: false, sessionId };
    setError('');
  }
  useEffect(() => {
    if (!enabledAt || !sessionId || document.hidden) return;
    const messages = useChatStore.getState().messages;
    const index = messages.findIndex(m => m.id === messageId);
    const hasNewerQuestion = index >= 0 && messages.slice(index + 1).some(m => m.role === 'user');
    if (hasNewerQuestion && questionCutoff.current === null) { interrupted.current = true; eligible.current = false; stop(); return; }
    if (eligibleSpeechMessage({ enabledAt, timestamp: messageTimestamp, newerQuestion: hasNewerQuestion && questionCutoff.current === null, recording, hidden: document.hidden, interrupted: interrupted.current }) && (live || completedAt)) eligible.current = true;
    if (recording || recordingHold.current || (owner && owner !== key)) return;
    if (!eligible.current) return;
    const body = root.current?.closest<HTMLElement>('[data-answer-body]');
    const spokenText = body ? renderedSpeechText(body) : '';
    const source = spokenText || text;
    if (questionCutoff.current !== null && !source.startsWith(questionCutoff.current)) {
      questionCutoff.current = ''; useSpeechSession.getState().commit(key, '');
    }
    const prefix = stableSpeechPrefix(source, !!completedAt);
    if (!prefix.trim()) return;
    const consumed = useSpeechSession.getState().consumed[key] || '';
    if (prefix === consumed && (!run.current || run.current.index >= run.current.chunks.length)) return;
    if (!useSpeechSession.getState().claim(key)) return;
    if (!run.current) { begin(true); interrupted.current = false; eligible.current = true; }
    const r = run.current!;
    if (!prefix.startsWith(r.committed)) { eligible.current = false; stop(); return; }
    const delta = prefix.slice(r.committed.length);
    if (delta.trim()) { r.chunks.push(...speechChunks(delta, r.chunks.length === 0)); r.committed = prefix; }
    if (r.audio && r.index + 1 < r.chunks.length) void request(r, r.index + 1);
    void pump();
  }, [text, completedAt, live, enabledAt, sessionId, messageTimestamp, recording, owner]);
  async function manual() {
    if (sessionId && useSpeechSession.getState().recording[sessionId]) {
      primeAnswerSpeechPlayer();
      setError('마지막 음성을 확정한 뒤 읽습니다.');
      const ok = await finalizeDictationForSend(sessionId);
      if (!ok || useSessionStore.getState().activeSessionId !== sessionId) { setError('음성 입력을 먼저 마무리해 주세요.'); return; }
      setError('');
    }
    recordingHold.current = false;
    const current = run.current;
    if (current?.audio) { try { await current.audio.play(); setState('playing'); setError(''); } catch { setError('재생을 시작할 수 없습니다.'); } return; }
    if (!current) {
      primeAnswerSpeechPlayer();
      begin(); const r = run.current; if (!r) return;
      const body = root.current?.closest<HTMLElement>('[data-answer-body]');
      const source = body ? renderedSpeechText(body) || text : text;
      r.chunks = speechChunks(source, true); r.committed = source;
    }
    void pump();
  }
  return <div ref={root} className="relative inline-flex items-center gap-2 text-sm" data-answer-speech>
    <style>{'::highlight(answer-speech) { background: color-mix(in srgb, currentColor 15%, transparent); }'}</style>
    <button type="button" aria-label={state === 'paused' ? '이어서 읽기' : '답변 읽기'} title={state === 'paused' ? '멈춘 위치부터 이어서 읽습니다.' : state === 'loading' ? '읽어줄 음성을 준비하고 있습니다.' : '이 답변만 AI 음성으로 읽습니다. 자동 읽기 설정은 바뀌지 않습니다.'} disabled={!sessionId || state === 'loading'} onClick={() => void manual()} className="rounded p-2 hover:bg-surface-700">{state === 'loading' ? '…' : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m11 5-5 4H3v6h3l5 4V5Zm4 3a6 6 0 0 1 0 8"/></svg>}</button>
    {state === 'playing' && <button type="button" className="min-h-11 min-w-11 rounded-lg px-3 md:min-h-0 md:min-w-0 md:px-1" title="잠시 멈춥니다. 읽기 버튼을 누르면 이어서 들을 수 있습니다." onClick={() => { run.current?.audio?.pause(); setState('paused'); }}>일시정지</button>}
    {run.current && <button type="button" className="min-h-11 min-w-11 rounded-lg px-3 md:min-h-0 md:min-w-0 md:px-1" title="현재 낭독과 준비 중인 음성을 취소합니다. 자동 읽기 설정은 유지됩니다." onClick={() => { interrupted.current = true; eligible.current = false; stop(); }}>종료</button>}
    {error && <span role="alert" className="absolute bottom-full right-0 w-64 rounded bg-surface-800 p-2 text-xs">{error}</span>}
  </div>;
}
