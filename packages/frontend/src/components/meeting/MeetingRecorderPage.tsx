import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';

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
  if (mixed.getAudioTracks().length === 0) throw new Error(i18n.t('meetingRecorder.error.noAudioTrack', { ns: 'common' }));

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
  const { t } = useTranslation('common');
  const [title, setTitle] = useState(() => i18n.t('meetingRecorder.defaultTitle', { ns: 'common', date: new Date().toLocaleString(i18n.resolvedLanguage || i18n.language) }));
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
    setLog((prev) => [`${new Date().toLocaleTimeString(i18n.resolvedLanguage || i18n.language)} · ${line}`, ...prev].slice(0, 80));
  }, []);

  const createRun = useCallback(async () => {
    setError(null);
    const res = await fetch('/api/meeting-recorder/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ title, source, language: 'ko-KR', saveAudio: true }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || t('meetingRecorder.error.createRun'));
    const data = await res.json();
    setRun(data.run);
    appendLog(t('meetingRecorder.log.runCreated', { id: data.run.id }));
    return data.run as MeetingRun;
  }, [appendLog, source, t, title]);

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
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || t('meetingRecorder.error.chunkUpload'));
    const data = await res.json();
    setRun(data.run);
    appendLog(t('meetingRecorder.log.chunkSaved', { index: data.segment.index, start: msLabel(startMs), end: msLabel(endMs), size: Math.round(blob.size / 1024) }));
  }, [appendLog, createRun, manualTranscript, run, t]);

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
          setError(err?.message || t('meetingRecorder.error.chunkUpload'));
          appendLog(t('meetingRecorder.log.error', { error: err?.message || err }));
        });
      };
      recorder.start(Math.max(5, chunkSeconds) * 1000);
      setRecording(true);
      appendLog(t('meetingRecorder.log.started', { id: activeRun.id }));
      tickRef.current = window.setInterval(() => setElapsedMs(Math.floor(performance.now() - startedAtRef.current)), 500);
    } catch (err: any) {
      setError(err?.message || t('meetingRecorder.error.start'));
      cleanupRef.current?.();
      cleanupRef.current = null;
    }
  }, [appendLog, chunkSeconds, createRun, run, source, t, uploadChunk]);

  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    recorderRef.current = null;
    cleanupRef.current?.();
    cleanupRef.current = null;
    if (tickRef.current !== null) window.clearInterval(tickRef.current);
    tickRef.current = null;
    setRecording(false);
    appendLog(t('meetingRecorder.log.stopped'));
    if (run) {
      await fetch(`/api/meeting-recorder/runs/${encodeURIComponent(run.id)}/end`, { method: 'POST', headers: authHeaders() }).catch(() => undefined);
    }
  }, [appendLog, run, t]);

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
          <h1 className="mt-3 text-3xl font-semibold">{t('meetingRecorder.title')}</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-surface-400">
            {t('meetingRecorder.description')}
          </p>
        </header>

        {!canRecord && <div className="rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-red-200">{t('meetingRecorder.unsupported')}</div>}
        {error && <div className="rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-red-200">{error}</div>}

        <section className="grid gap-4 rounded-3xl border border-surface-800 bg-surface-900/80 p-5 md:grid-cols-2">
          <label className="flex flex-col gap-2 text-sm text-surface-300 md:col-span-2">
            {t('meetingRecorder.meetingTitle')}
            <input className="rounded-xl border border-surface-700 bg-surface-950 px-3 py-2 text-surface-100 outline-none focus:border-primary-500" value={title} onChange={(e) => setTitle(e.target.value)} disabled={recording} />
          </label>
          <label className="flex flex-col gap-2 text-sm text-surface-300">
            {t('meetingRecorder.captureSource')}
            <select className="rounded-xl border border-surface-700 bg-surface-950 px-3 py-2 text-surface-100" value={source} onChange={(e) => setSource(e.target.value as MeetingSource)} disabled={recording}>
              <option value="mic">{t('meetingRecorder.source.mic')}</option>
              <option value="tab-audio">{t('meetingRecorder.source.tab')}</option>
              <option value="mixed">{t('meetingRecorder.source.mixed')}</option>
            </select>
          </label>
          <label className="flex flex-col gap-2 text-sm text-surface-300">
            {t('meetingRecorder.chunkLength')}
            <select className="rounded-xl border border-surface-700 bg-surface-950 px-3 py-2 text-surface-100" value={chunkSeconds} onChange={(e) => setChunkSeconds(Number(e.target.value))} disabled={recording}>
              <option value={10}>{t('meetingRecorder.seconds', { count: 10 })}</option>
              <option value={15}>{t('meetingRecorder.seconds', { count: 15 })}</option>
              <option value={30}>{t('meetingRecorder.seconds', { count: 30 })}</option>
              <option value={60}>{t('meetingRecorder.seconds', { count: 60 })}</option>
            </select>
          </label>
          <label className="flex flex-col gap-2 text-sm text-surface-300 md:col-span-2">
            {t('meetingRecorder.manualTranscript')}
            <textarea className="min-h-24 rounded-xl border border-surface-700 bg-surface-950 px-3 py-2 text-surface-100 outline-none focus:border-primary-500" value={manualTranscript} onChange={(e) => setManualTranscript(e.target.value)} placeholder={t('meetingRecorder.manualPlaceholder')} />
          </label>
          <div className="flex flex-wrap items-center gap-3 md:col-span-2">
            {!recording ? (
              <button className="rounded-xl bg-primary-500 px-4 py-2 font-medium text-white hover:bg-primary-400 disabled:opacity-50" onClick={startRecording} disabled={!canRecord}>{t('meetingRecorder.start')}</button>
            ) : (
              <button className="rounded-xl bg-red-500 px-4 py-2 font-medium text-white hover:bg-red-400" onClick={stopRecording}>{t('meetingRecorder.stop')}</button>
            )}
            <div className="text-sm text-surface-400">{t('meetingRecorder.elapsed', { time: msLabel(elapsedMs) })}</div>
          </div>
        </section>

        {run && (
          <section className="rounded-3xl border border-surface-800 bg-surface-900/80 p-5">
            <h2 className="text-lg font-semibold">{t('meetingRecorder.currentRun')}</h2>
            <div className="mt-3 grid gap-2 text-sm text-surface-300">
              <div><span className="text-surface-500">ID</span> {run.id}</div>
              <div><span className="text-surface-500">Markdown</span> <code className="text-primary-300">{run.markdownPath}</code></div>
              <div><span className="text-surface-500">Transcript JSONL</span> <code className="text-primary-300">{run.transcriptPath}</code></div>
            </div>
          </section>
        )}

        <section className="rounded-3xl border border-surface-800 bg-surface-900/80 p-5">
          <h2 className="text-lg font-semibold">{t('meetingRecorder.logs')}</h2>
          <div className="mt-3 max-h-72 overflow-auto rounded-2xl bg-surface-950 p-3 font-mono text-xs text-surface-300">
            {log.length ? log.map((line, i) => <div key={i}>{line}</div>) : <div className="text-surface-500">{t('meetingRecorder.noLogs')}</div>}
          </div>
        </section>
      </div>
    </div>
  );
}
