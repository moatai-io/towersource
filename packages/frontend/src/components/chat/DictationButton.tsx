import { useShortcutStore, matchesShortcut, formatShortcut } from '../../stores/shortcut-store';
import { useSpeechSession } from './answer-speech-session';
import { registerDictationFinalizer } from './dictation-submit';
import { startRealtimeDictation } from './realtime-dictation';
import { useEffect, useRef, useState } from 'react';

export async function readDictationResponse(response: Response): Promise<string> {
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('음성 입력 서버가 올바르게 연결되지 않았습니다. 새로고침 후 다시 시도해 주세요.');
  }
  let data: { text?: unknown; error?: unknown };
  try { data = await response.json(); } catch { throw new Error('음성 변환 응답을 읽지 못했습니다. 다시 시도해 주세요.'); }
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : '음성 변환에 실패했습니다.');
  if (typeof data.text !== 'string') throw new Error('음성 변환 결과가 올바르지 않습니다.');
  return data.text;
}

/** Input-only dictation: no assistant turn, playback, or automatic send. */
export function DictationButton({ sessionId, disabled, onText, onPreview, onStart, mobile, waveformTarget }: { sessionId: string | null; disabled?: boolean; onText: (text: string) => void; onPreview?: (text: string) => void; onStart?: () => void; mobile?: boolean; waveformTarget?: HTMLElement | null }) {
  const [phase, setPhase] = useState<'idle' | 'starting' | 'recording' | 'converting'>('idle');
  const [error, setError] = useState('');
  const [captureReady, setCaptureReady] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef<Awaited<ReturnType<typeof startRealtimeDictation>> | null>(null);
  const generation = useRef(0);
  const stream = useRef<MediaStream | null>(null);
  const context = useRef<AudioContext | null>(null);
  const frame = useRef(0);
  const cancelled = useRef(false);
  const alive = useRef(true);

  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  function release() {
    cancelAnimationFrame(frame.current);
    stream.current?.getTracks().forEach(track => track.stop());
    stream.current = null;
    void context.current?.close().catch(() => {});
    context.current = null;
  }
  function cancel() {
    generation.current++;
    live.current?.cancel(); live.current = null; onPreview?.('');
    cancelled.current = true;

    release();
    if (alive.current) setPhase('idle');
  }
  useEffect(() => {
    alive.current = true;
    setError('');
    setPhase('idle');
    setSeconds(0);
    return () => { alive.current = false; cancel(); };
  }, [sessionId]);
  useEffect(() => {
    const stop = () => cancel();
    const visibility = () => { if (document.hidden) cancel(); };
    window.addEventListener('tower-dictation-stop', stop);
    document.addEventListener('visibilitychange', visibility);
    return () => { window.removeEventListener('tower-dictation-stop', stop); document.removeEventListener('visibilitychange', visibility); };
  }, [sessionId]);
  useEffect(() => {
    if (phase !== 'recording') return;
    const timer = window.setInterval(() => setSeconds(value => value + 1), 1000);
    const limit = window.setTimeout(() => void finish(), 120_000);
    return () => { clearInterval(timer); clearTimeout(limit); };
  }, [phase]);
  useEffect(() => {
    if (!sessionId) return;
    useSpeechSession.getState().setRecording(sessionId, phase !== 'idle');
    return () => useSpeechSession.getState().setRecording(sessionId, false);
  }, [sessionId, phase]);
  async function start() {
    if (sessionId) useSpeechSession.getState().setRecording(sessionId, true);
    window.dispatchEvent(new Event('tower-speech-recording'));
    onStart?.();
    const run = ++generation.current;
    setError(''); setCaptureReady(false); setSeconds(0); setPhase('starting'); cancelled.current = false;
    try {
      if (!sessionId || !navigator.mediaDevices?.getUserMedia) throw new Error('이 브라우저에서는 음성 녹음을 지원하지 않습니다.');
      const connection = await startRealtimeDictation(sessionId, text => { if (run === generation.current && alive.current && !cancelled.current) { onTextRef.current(text); onPreview?.(text); } }, message => { if (run === generation.current && alive.current) { release(); onPreview?.(''); setError(message); setPhase('idle'); } }, () => { if (run === generation.current && alive.current) setCaptureReady(true); });
      if (run !== generation.current || cancelled.current || !alive.current) { connection.cancel(); return; }
      live.current = connection;
      const media = connection.stream;
      stream.current = media;
      const audioContext = new AudioContext(); context.current = audioContext;
      const analyser = audioContext.createAnalyser(); analyser.fftSize = 256;
      audioContext.createMediaStreamSource(media).connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      const history = new Array<number>(18).fill(1);
      const stepMs = 80;
      let lastSample = performance.now();
      let accumulatedPeak = 0;
      function draw() {
        const now = performance.now();
        analyser.getByteTimeDomainData(samples);
        let energy = 0;
        for (const sample of samples) energy += ((sample - 128) / 128) ** 2;
        accumulatedPeak = Math.max(accumulatedPeak, Math.sqrt(energy / samples.length));
        if (now - lastSample >= stepMs) {
          const steps = Math.min(history.length, Math.floor((now - lastSample) / stepMs));
          for (let step = 0; step < steps; step++) {
            history.shift();
            history.push(step === steps - 1 ? Math.max(1, Math.min(22, accumulatedPeak * 70)) : 1);
          }
          lastSample += Math.floor((now - lastSample) / stepMs) * stepMs;
          accumulatedPeak = 0;
        }
        const surface = canvas.current; const pen = surface?.getContext('2d');
        if (surface && pen) {
          pen.clearRect(0, 0, surface.width, surface.height);
          pen.strokeStyle = getComputedStyle(surface).color; pen.lineWidth = 3; pen.lineCap = 'round';
          const spacing = (surface.width - 8) / 15;
          const offset = (now - lastSample) / stepMs * spacing;
          for (let bar = 0; bar < history.length; bar++) {
            const height = history[bar];
            const x = 4 + (bar - 1) * spacing - offset;
            pen.beginPath(); pen.moveTo(x, (surface.height - height) / 2); pen.lineTo(x, (surface.height + height) / 2); pen.stroke();
          }
        }
        frame.current = requestAnimationFrame(draw);
      }
      setPhase('recording'); draw();
    } catch (err) { live.current?.cancel(); release(); if (run === generation.current && alive.current && !cancelled.current) { setError(err instanceof Error && err.name !== 'NotAllowedError' ? err.message : '마이크 사용 권한을 허용해 주세요.'); setPhase('idle'); } }
  }
  const finishing = useRef<Promise<boolean> | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    return registerDictationFinalizer(sessionId, () => finishing.current || (phase === 'recording' ? finish() : (phase === 'idle' && !error)));
  }, [sessionId, phase, error]);
  function finish(): Promise<boolean> {
    if (finishing.current) return finishing.current;
    const task = finishNow().finally(() => { finishing.current = null; });
    finishing.current = task;
    return task;
  }
  async function finishNow(): Promise<boolean> {
    const connection = live.current;
    if (!connection || phase !== 'recording') return false;
    const run = generation.current;
    setPhase('converting'); release();
    try {
      const text = await connection.finish();
      if (run === generation.current && !cancelled.current && alive.current) { live.current = null; onPreview?.(''); if (text.trim()) onTextRef.current(text); setPhase('idle'); await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); return true; }
      return false;
    } catch (err) {
      if (run === generation.current && alive.current) { onPreview?.(''); setError(err instanceof Error ? err.message : '받아쓰기를 확정하지 못했습니다.'); setPhase('idle'); }
      return false;
    }
  }
  const binding = useShortcutStore(s => s.bindings['voice.toggle']);
  const shortcut = formatShortcut(binding);
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!matchesShortcut(event, binding)) return;
      if (!sessionId || disabled) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[role="dialog"], [aria-modal="true"], [role="menu"], [role="listbox"]')
        || document.querySelector('[aria-modal="true"], [data-shortcut-settings]')) return;
      // Only the active composer may handle typing shortcuts; other fields retain their keys.
      const editable = target?.closest('input, textarea, [contenteditable="true"]');
      if (editable && editable !== waveformTarget
        && !editable.closest('[data-chat-composer]')?.contains(buttonRef.current ?? null)) return;
      event.preventDefault();
      if (phase === 'idle') void start();
      else if (phase === 'recording') void finish();
      // Starting/converting must not be cancelled by a second shortcut press.
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [sessionId, disabled, phase, waveformTarget, binding]);
  const buttonStyle = 'inline-flex items-center justify-center shrink-0 rounded-xl p-0 text-surface-400 hover:bg-surface-700/45 hover:text-surface-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 disabled:opacity-40';
  return <div className={`relative self-end flex items-center ${mobile ? 'min-w-0' : 'shrink-0'}`}>
    {phase === 'recording' && <span className="flex shrink-0 items-center gap-1" aria-label="음성 녹음 중">
      <canvas ref={canvas} width={48} height={16} className="h-4 w-8 text-surface-400" aria-label="녹음 음량 파형" />
    </span>}
    {(phase === 'starting' || phase === 'converting') && <span role="status" className="max-w-20 truncate text-[11px] text-surface-400">{phase === 'starting' ? '연결 중…' : '확정 중…'}</span>}
    <button ref={buttonRef} type="button" disabled={phase === 'idle' && (disabled || !sessionId)} onClick={() => phase === 'idle' ? void start() : phase === 'recording' ? void finish() : cancel()} aria-label={phase === 'idle' ? '음성 입력 시작' : phase === 'recording' ? '녹음 종료 및 받아쓰기' : '음성 입력 취소'} aria-keyshortcuts={binding.replace('Mod', /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control') || undefined} title={`${shortcut} · ${phase === 'recording' ? '녹음을 끝내고 받아쓴 글을 유지합니다. 전송은 직접 눌러 주세요.' : phase === 'idle' ? '말을 글로 입력합니다. 답변 자동 읽기 설정은 바뀌지 않습니다.' : '음성 입력을 취소합니다.'}`} className={`${buttonStyle} ${mobile ? 'h-12 w-12' : 'h-10 w-10'}`}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {phase === 'recording' ? <rect x="6" y="6" width="12" height="12" rx="2" /> : <><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></>}
      </svg>
    </button>
    {error && <div className="absolute bottom-full right-0 z-40 mb-2 w-[min(18rem,calc(100vw-3rem))] rounded-xl border border-surface-700 bg-surface-900 p-3 text-surface-100 shadow-lg">
      <div className="flex items-center gap-2">

        <span role="status" className="text-xs">{phase === 'starting' ? (captureReady ? '말씀하세요 · 연결 준비 중' : '마이크 준비 중') : phase === 'converting' ? '받아쓰는 중…' : phase === 'recording' ? '녹음 중' : ''}</span>
        <button type="button" onClick={() => { cancel(); setError(''); }} aria-label={error ? '음성 입력 오류 닫기' : '음성 입력 취소'} title={error ? '오류 안내를 닫습니다.' : '음성 입력을 취소하고 마이크를 끕니다.'} className="ml-auto shrink-0 rounded p-1 text-surface-400 hover:text-surface-100"><svg width="16" height="16" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg></button>
      </div>
      {error && <p role="alert" className="m-0 text-xs leading-relaxed break-words">{error}</p>}
    </div>}
  </div>;
}
