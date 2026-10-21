import { primeAnswerSpeechPlayer } from './answer-speech-player';
import { create } from 'zustand';
import { useEffect, useRef, useState } from 'react';
export const useAnswerVoice = create<{ enabledAt: Record<string, number>; toggle: (sessionId: string) => void }>((set) => ({
  enabledAt: {},
  toggle: sessionId => set(state => {
    const enabledAt = { ...state.enabledAt };
    if (enabledAt[sessionId]) { delete enabledAt[sessionId]; window.dispatchEvent(new Event('tower-speech-stop')); }
    else enabledAt[sessionId] = Date.now();
    return { enabledAt };
  }),
}));
/** Per-session, in-memory opt-in. History and background sessions never trigger playback. */
export function AnswerVoiceToggle({ sessionId }: { sessionId: string | null }) {
  const enabled = useAnswerVoice(s => !!(sessionId && s.enabledAt[sessionId]));
  const toggle = useAnswerVoice(s => s.toggle);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => { request.current?.abort(); setChecking(false); setError(''); return () => request.current?.abort(); }, [sessionId]);
  async function enable() {
    if (!sessionId) return;
    if (enabled) { toggle(sessionId); return; }
    primeAnswerSpeechPlayer();
    const controller = new AbortController(); request.current = controller;
    setChecking(true); setError('');
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/voice-readiness`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: controller.signal });
      const data = await response.json();
      if (!response.ok || !data.connections?.some((connection: { apiId: string; configured: boolean }) => connection.apiId === 'text-to-speech' && connection.configured)) throw new Error('Voice connections unavailable');
      if (!controller.signal.aborted) toggle(sessionId);
    } catch { if (!controller.signal.aborted) setError('답변 자동 읽기 연결을 확인하지 못했습니다.'); }
    finally { if (!controller.signal.aborted) setChecking(false); }
  }
  return <span className="relative flex shrink-0 self-end items-center"><button type="button" disabled={!sessionId || checking} aria-pressed={enabled} aria-label="답변 자동 읽기" title={enabled ? '새 답변 자동 읽기를 끄고 현재 낭독을 멈춥니다. 마이크 설정은 바뀌지 않습니다.' : '이 세션의 새 답변을 자동으로 읽습니다. 마이크는 켜지지 않으며, 다음 질문을 전송하면 현재 낭독이 멈춥니다.'} onClick={() => void enable()} className={`inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl p-0 md:h-10 md:w-10 ${enabled ? 'bg-primary-500/15 text-primary-400' : 'text-surface-400 hover:bg-surface-700'}`}>
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m11 5-5 4H3v6h3l5 4V5Z"/><path strokeLinecap="round" d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/></svg>
  </button>{error && <span role="alert" className="absolute bottom-full right-0 mb-2 w-64 rounded bg-surface-800 p-2 text-xs">{error}</span>}</span>;
}
