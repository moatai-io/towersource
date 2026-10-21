export async function startRealtimeDictation(sessionId: string, onPreview: (text: string) => void, onError: (message: string) => void, onCaptureReady?: () => void) {
  const startedAt = performance.now();
  const timing: Record<string, number> = {};
  const stamp = (stage: string) => { timing[stage] = Math.round(performance.now() - startedAt); };
  // Start network setup alongside the permission prompt rather than serially.
  const token = localStorage.getItem('token');
  const sessionRequest = fetch(`/api/sessions/${encodeURIComponent(sessionId)}/dictation/session`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(25000) });
  void sessionRequest.then(() => stamp('tokenResponseMs'), () => {});
  void sessionRequest.catch(() => {});
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stamp('microphoneReadyMs');
  const pending: string[] = [];
  const maxBufferedChunks = 150; // ~25 seconds at 24 kHz / 4096 samples; never persisted.
  let overflow = false;
  let socket: WebSocket | undefined;
  let context: AudioContext | undefined;
  let processor: ScriptProcessorNode | undefined;
  let closed = false;
  let text = '';
  let settle: (() => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  let finalItem: string | undefined;
  let sentSamples = 0;
  const cleanup = () => { closed = true; processor?.disconnect(); stream.getTracks().forEach(track => track.stop()); pending.length = 0; socket?.close(); void context?.close(); };
  try {
    context = new AudioContext({ sampleRate: 24000 });
    const source = context.createMediaStreamSource(stream);
    processor = context.createScriptProcessor(4096, 1, 1);
    source.connect(processor); processor.connect(context.destination);
    processor.onaudioprocess = event => {
      if (closed || overflow) return;
      const samples = event.inputBuffer.getChannelData(0);
      sentSamples += samples.length;
      const pcm = new Int16Array(samples.length);
      for (let i = 0; i < samples.length; i++) pcm[i] = Math.max(-1, Math.min(1, samples[i])) * 32767;
      const bytes = new Uint8Array(pcm.buffer);
      let binary = ''; bytes.forEach(byte => { binary += String.fromCharCode(byte); });
      const payload = JSON.stringify({ type: 'input_audio_buffer.append', audio: btoa(binary) });
      if (socket?.readyState === WebSocket.OPEN) socket.send(payload);
      else if (pending.length < maxBufferedChunks) pending.push(payload);
      else { overflow = true; cleanup(); onError('연결 준비가 오래 걸려 녹음을 중단했습니다. 다시 시도해 주세요.'); }
    };
    stamp('captureStartedMs');
    onCaptureReady?.();
    const response = await sessionRequest;
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('실시간 음성 입력 서버가 연결되지 않았습니다.');
    const data = await response.json();
    if (!response.ok || !data.value) throw new Error(data.error || '실시간 연결에 실패했습니다.');
    socket = new WebSocket('wss://api.openai.com/v1/realtime?intent=transcription', ['realtime', `openai-insecure-api-key.${data.value}`]);
    await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('실시간 연결 시간이 초과되었습니다.')), 15000); socket!.onopen = () => { clearTimeout(timeout); resolve(); }; socket!.onerror = () => { clearTimeout(timeout); reject(new Error('실시간 연결에 실패했습니다.')); }; });
    if (overflow) throw new Error('음성 연결 준비 시간이 초과되었습니다.');
    stamp('socketOpenMs');
    // Only numeric timings: never audio, credentials, or transcript.
    window.dispatchEvent(new CustomEvent('dictation-startup-timing', { detail: { ...timing, bufferedChunks: pending.length } }));
    const parts = new Map<string, string>();
    socket.onmessage = event => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'error') { fail?.(new Error('실시간 받아쓰기 오류가 발생했습니다.')); onError('실시간 받아쓰기 오류가 발생했습니다.'); cleanup(); return; }
        if (message.type === 'input_audio_buffer.committed') finalItem = message.item_id;
        if (message.type === 'conversation.item.input_audio_transcription.delta') parts.set(message.item_id, (parts.get(message.item_id) || '') + message.delta);
        if (message.type === 'conversation.item.input_audio_transcription.completed') { parts.set(message.item_id, message.transcript); if (message.item_id === finalItem) settle?.(); }
        text = [...parts.values()].join(' '); onPreview(text);
      } catch { /* Ignore unrelated/non-text events. */ }
    };
    socket.onclose = () => { if (!closed) { fail?.(new Error('실시간 연결이 종료되었습니다.')); onError('실시간 연결이 종료되었습니다.'); cleanup(); } };
    for (const payload of pending) socket.send(payload);
    pending.length = 0;
    return { stream, cancel: cleanup, finish: async () => {
      processor?.disconnect(); stream.getTracks().forEach(track => track.stop());
      if (sentSamples < 2400) { cleanup(); return ''; }
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('마지막 문장을 확정하는 시간이 초과되었습니다. 다시 녹음해 주세요.')), 15000);
          settle = () => { clearTimeout(timeout); resolve(); };
          fail = error => { clearTimeout(timeout); reject(error); };
          if (socket?.readyState !== WebSocket.OPEN) { fail(new Error('음성 연결이 종료되었습니다.')); return; }
          socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        });
        return text;
      } finally { cleanup(); }
    } };
  } catch (error) { cleanup(); throw error; }
}
