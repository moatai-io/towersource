import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type MeetingSource = 'mic' | 'tab-audio' | 'mixed';

type MeetingRun = {
  id: string;
  title: string;
  source: MeetingSource | 'upload';
  language: string;
  status: 'live' | 'ended';
  markdownPath: string;
  transcriptPath: string;
  dir: string;
  updatedAt: string;
};

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function msLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

async function createMixedStream(source: MeetingSource): Promise<{ stream: MediaStream; cleanup: () => void }> {
  const streams: MediaStream[] = [];
  const audioContext = new AudioContext();
  const destination = audioContext.createMediaStreamDestination();

  async function addAudioStream(stream: MediaStream) {
    streams.push(stream);
    const tracks = stream.getAudioTracks();
    if (tracks.length === 0) return;
    const src = audioContext.createMediaStreamSource(new MediaStream(tracks));
    src.connect(destination);
  }

  if (source === 'mic' || source === 'mixed') {
    await addAudioStream(await navigator.mediaDevices.getUserMedia({ audio: true }));
  }

  if (source === 'tab-audio' || source === 'mixed') {
    const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    await addAudioStream(displayStream);
  }

  const mixed = destination.stream;
  if (mixed.getAudioTracks().length === 0) throw new Error('캡처된 오디오 트랙이 없습니다. 탭 공유 시 오디오 공유 옵션을 켰는지 확인하세요.');

  return {
    stream: mixed,
    cleanup: () => {
      for (const s of streams) s.getTracks().forEach((t) => t.stop());
      mixed.getTracks().forEach((t) => t.stop());
      void audioContext.close().catch(() => undefined);
    },
  };
}

export function MeetingRecorderPage() {
  const [title, setTitle] = useState(() => `회의 녹음 ${new Date().toLocaleString('ko-KR')}`);
  const [source, setSource] = useState<MeetingSource>('mic');
  const [chunkSeconds, setChunkSeconds] = useState(15);
  const [run, setRun] = useState<MeetingRun | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [manualTranscript, setManualTranscript] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const startedAtRef = useRef<number>(0);
  const chunkStartRef = useRef<number>(0);
  const tickRef = useRef<number | null>(null);

  const canRecord = useMemo(() => typeof navigator !== 'undefined' && !!navigator.mediaDevices && typeof MediaRecorder !== 'undefined', []);

  const appendLog = useCallback((line: string) => {
    setLog((prev) => [`${new Date().toLocaleTimeString('ko-KR')} · ${line}`, ...prev].slice(0, 80));
  }, []);

  const createRun = useCallback(async () => {
    setError(null);
    const res = await fetch('/api/meeting-recorder/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ title, source, language: 'ko-KR', saveAudio: true }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || 'meeting run 생성 실패');
    const data = await res.json();
    setRun(data.run);
    appendLog(`run 생성: ${data.run.id}`);
    return data.run as MeetingRun;
  }, [appendLog, source, title]);

  const uploadChunk = useCallback(async (blob: Blob, startMs: number, endMs: number) => {
    const activeRun = run ?? await createRun();
    const form = new FormData();
    form.append('startMs', String(startMs));
    form.append('endMs', String(endMs));
    if (manualTranscript.trim()) {
      form.append('transcriptText', manualTranscript.trim());
      setManualTranscript('');
    }
    form.append('audio', blob, `chunk-${Date.now()}.webm`);
    const res = await fetch(`/api/meeting-recorder/runs/${encodeURIComponent(activeRun.id)}/chunks`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || 'chunk 업로드 실패');
    const data = await res.json();
    setRun(data.run);
    appendLog(`chunk ${data.segment.index} 저장 · ${msLabel(startMs)}–${msLabel(endMs)} · ${Math.round(blob.size / 1024)}KB`);
  }, [appendLog, createRun, manualTranscript, run]);

  const startRecording = useCallback(async () => {
    try {
      setError(null);
      const activeRun = run ?? await createRun();
      const { stream, cleanup } = await createMixedStream(source);
      cleanupRef.current = cleanup;
      startedAtRef.current = performance.now();
      chunkStartRef.current = 0;
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
      const recorder = new MediaRecorder(stream, { mimeType });
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (!event.data || event.data.size === 0) return;
        const startMs = chunkStartRef.current;
        const endMs = Math.floor(performance.now() - startedAtRef.current);
        chunkStartRef.current = endMs;
        void uploadChunk(event.data, startMs, endMs).catch((err) => {
          setError(err?.message || 'chunk 업로드 오류');
          appendLog(`오류: ${err?.message || err}`);
        });
      };
      recorder.start(Math.max(5, chunkSeconds) * 1000);
      setRecording(true);
      appendLog(`녹음 시작: ${activeRun.id}`);
      tickRef.current = window.setInterval(() => setElapsedMs(Math.floor(performance.now() - startedAtRef.current)), 500);
    } catch (err: any) {
      setError(err?.message || '녹음 시작 실패');
      cleanupRef.current?.();
      cleanupRef.current = null;
    }
  }, [appendLog, chunkSeconds, createRun, run, source, uploadChunk]);

  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    recorderRef.current = null;
    cleanupRef.current?.();
    cleanupRef.current = null;
    if (tickRef.current !== null) window.clearInterval(tickRef.current);
    tickRef.current = null;
    setRecording(false);
    appendLog('녹음 중지');
    if (run) {
      await fetch(`/api/meeting-recorder/runs/${encodeURIComponent(run.id)}/end`, { method: 'POST', headers: authHeaders() }).catch(() => undefined);
    }
  }, [appendLog, run]);

  useEffect(() => () => {
    if (tickRef.current !== null) window.clearInterval(tickRef.current);
    recorderRef.current?.stop();
    cleanupRef.current?.();
  }, []);

  return (
    <div className="min-h-screen bg-surface-950 text-surface-100">
      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-5 py-8">
        <header className="rounded-3xl border border-surface-800 bg-surface-900/80 p-6 shadow-2xl">
          <div className="text-sm uppercase tracking-[0.25em] text-primary-300">Tower Meeting Recorder MVP</div>
          <h1 className="mt-3 text-3xl font-semibold">회의 음성을 chunk로 캡처해서 markdown으로 쌓기</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-surface-400">
            첫 버전은 STT 통합 전 단계입니다. 오디오는 15초 단위로 서버에 저장되고, 수동 transcript 메모가 있으면 함께 live-meeting.md에 반영됩니다.
          </p>
        </header>

        {!canRecord && <div className="rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-red-200">이 브라우저는 MediaRecorder/getUserMedia를 지원하지 않습니다.</div>}
        {error && <div className="rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-red-200">{error}</div>}

        <section className="grid gap-4 rounded-3xl border border-surface-800 bg-surface-900/80 p-5 md:grid-cols-2">
          <label className="flex flex-col gap-2 text-sm text-surface-300 md:col-span-2">
            회의 제목
            <input className="rounded-xl border border-surface-700 bg-surface-950 px-3 py-2 text-surface-100 outline-none focus:border-primary-500" value={title} onChange={(e) => setTitle(e.target.value)} disabled={recording} />
          </label>
          <label className="flex flex-col gap-2 text-sm text-surface-300">
            캡처 소스
            <select className="rounded-xl border border-surface-700 bg-surface-950 px-3 py-2 text-surface-100" value={source} onChange={(e) => setSource(e.target.value as MeetingSource)} disabled={recording}>
              <option value="mic">마이크</option>
              <option value="tab-audio">탭/화면 오디오</option>
              <option value="mixed">마이크 + 탭 오디오 믹스</option>
            </select>
          </label>
          <label className="flex flex-col gap-2 text-sm text-surface-300">
            오디오 chunk 길이
            <select className="rounded-xl border border-surface-700 bg-surface-950 px-3 py-2 text-surface-100" value={chunkSeconds} onChange={(e) => setChunkSeconds(Number(e.target.value))} disabled={recording}>
              <option value={10}>10초</option>
              <option value={15}>15초</option>
              <option value={30}>30초</option>
              <option value={60}>60초</option>
            </select>
          </label>
          <label className="flex flex-col gap-2 text-sm text-surface-300 md:col-span-2">
            다음 chunk에 같이 저장할 수동 transcript / 메모
            <textarea className="min-h-24 rounded-xl border border-surface-700 bg-surface-950 px-3 py-2 text-surface-100 outline-none focus:border-primary-500" value={manualTranscript} onChange={(e) => setManualTranscript(e.target.value)} placeholder="STT 붙이기 전까지는 여기에 들리는 말/요약을 적어두면 다음 chunk와 함께 markdown에 들어갑니다." />
          </label>
          <div className="flex flex-wrap items-center gap-3 md:col-span-2">
            {!recording ? (
              <button className="rounded-xl bg-primary-500 px-4 py-2 font-medium text-white hover:bg-primary-400 disabled:opacity-50" onClick={startRecording} disabled={!canRecord}>녹음 시작</button>
            ) : (
              <button className="rounded-xl bg-red-500 px-4 py-2 font-medium text-white hover:bg-red-400" onClick={stopRecording}>녹음 중지</button>
            )}
            <div className="text-sm text-surface-400">경과 {msLabel(elapsedMs)}</div>
          </div>
        </section>

        {run && (
          <section className="rounded-3xl border border-surface-800 bg-surface-900/80 p-5">
            <h2 className="text-lg font-semibold">현재 run</h2>
            <div className="mt-3 grid gap-2 text-sm text-surface-300">
              <div><span className="text-surface-500">ID</span> {run.id}</div>
              <div><span className="text-surface-500">Markdown</span> <code className="text-primary-300">{run.markdownPath}</code></div>
              <div><span className="text-surface-500">Transcript JSONL</span> <code className="text-primary-300">{run.transcriptPath}</code></div>
            </div>
          </section>
        )}

        <section className="rounded-3xl border border-surface-800 bg-surface-900/80 p-5">
          <h2 className="text-lg font-semibold">로그</h2>
          <div className="mt-3 max-h-72 overflow-auto rounded-2xl bg-surface-950 p-3 font-mono text-xs text-surface-300">
            {log.length ? log.map((line, i) => <div key={i}>{line}</div>) : <div className="text-surface-500">아직 로그가 없습니다.</div>}
          </div>
        </section>
      </div>
    </div>
  );
}
