/** Owns: Browser microphone connection for Tower's ephemeral LiveKit voice mode. */
import { useEffect, useReducer, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Room, RoomEvent, type LocalAudioTrack, type RemoteTrack, type RemoteTrackPublication, type RemoteParticipant } from 'livekit-client';

import { isVoiceEnabled } from '../../config/voice-feature';
import { VoiceLiveTranscript } from './VoiceLiveTranscript';
import { initialVoiceTranscriptState, parseVoiceUiMessage, voiceTranscriptReducer, VOICE_UI_TOPIC } from './VoiceLiveTranscript.reducer';

interface VoiceConversationButtonProps {
  sessionId: string | null;
  inferenceTtsProvider?: 'cartesia' | 'inworld';
}
type VoiceState = 'idle' | 'connecting' | 'listening' | 'speaking' | 'error';
type PlaybackStatus = 'waiting' | 'participant' | 'track' | 'playing' | 'blocked';

export function VoiceConversationButton(props: VoiceConversationButtonProps) {
  return isVoiceEnabled() ? <EnabledVoiceConversationButton {...props} /> : null;
}

function EnabledVoiceConversationButton({ sessionId, inferenceTtsProvider = 'cartesia' }: VoiceConversationButtonProps) {
  const { t } = useTranslation('chat');
  const [state, setState] = useState<VoiceState>('idle');
  const [audioLevel, setAudioLevel] = useState(0);
  const [errorMessage, setErrorMessage] = useState('');
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const [playbackStatus, setPlaybackStatus] = useState<PlaybackStatus>('waiting');
  const [microphonePublished, setMicrophonePublished] = useState(false);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [transcript, dispatchTranscript] = useReducer(voiceTranscriptReducer, initialVoiceTranscriptState);
  const agentIdentityRef = useRef<string | null>(null);
  const reconnectingRef = useRef(false);
  const generationRef = useRef(0);
  const roomRef = useRef<Room | null>(null);
  const voiceSessionIdRef = useRef<string | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const meterFrameRef = useRef<number | null>(null);
  const subscriptionTimerRef = useRef<number | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

  const resetTranscript = () => {
    agentIdentityRef.current = null;
    setAudioPlaying(false);
    dispatchTranscript({ type: 'clear' });
  };

  const stop = async () => {
    generationRef.current += 1;
    resetTranscript();
    const room = roomRef.current;
    roomRef.current = null;
    void room?.disconnect();
    if (remoteAudioRef.current) {
      remoteAudioRef.current.pause();
      remoteAudioRef.current.srcObject = null;
    }
    if (meterFrameRef.current !== null) cancelAnimationFrame(meterFrameRef.current);
    meterFrameRef.current = null;
    if (subscriptionTimerRef.current !== null) window.clearInterval(subscriptionTimerRef.current);
    subscriptionTimerRef.current = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
    setAudioLevel(0);
    setPlaybackBlocked(false);
    setPlaybackStatus('waiting');
    setMicrophonePublished(false);
    if (sessionId && voiceSessionIdRef.current) {
      const token = localStorage.getItem('token');
      await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/voice/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ voiceSessionId: voiceSessionIdRef.current }),
      }).catch(() => undefined);
    }
    voiceSessionIdRef.current = null;
    setState('idle');
  };

  useEffect(() => () => {
    generationRef.current += 1;
    const room = roomRef.current;
    roomRef.current = null;
    void room?.disconnect();
    if (meterFrameRef.current !== null) cancelAnimationFrame(meterFrameRef.current);
    if (subscriptionTimerRef.current !== null) window.clearInterval(subscriptionTimerRef.current);
    void audioContextRef.current?.close();
  }, []);

  const start = async () => {
    if (!sessionId || (state !== 'idle' && state !== 'error')) return;
    const generation = ++generationRef.current;
    const isCurrent = () => generationRef.current === generation;
    resetTranscript();
    reconnectingRef.current = false;
    setErrorMessage('');
    setState('connecting');
    let connectStage = t('voice.stage.startRequest');
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/voice/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ maxSpokenSeconds: 30, inferenceTtsProvider }),
      });
      const responseText = await response.text();
      let result: any = {};
      if (responseText) {
        try {
          result = JSON.parse(responseText);
        } catch {
          throw new Error(t('voice.invalidResponse', { status: response.status }));
        }
      }
      if (!response.ok || !result.livekit?.url || !result.livekit?.token) {
        throw new Error(result.error || t('voice.noResponse', { status: response.status }));
      }

      if (!isCurrent()) return;
      connectStage = t('voice.stage.liveKit');
      const room = new Room({ adaptiveStream: false, dynacast: false });
      roomRef.current = room;
      voiceSessionIdRef.current = result.voiceSession.id;
      const isCurrentRoom = () => isCurrent() && roomRef.current === room;
      const isTrustedAgent = (participant?: RemoteParticipant) => !!participant?.isAgent
        && room.remoteParticipants.get(participant.identity) === participant
        && (!agentIdentityRef.current || agentIdentityRef.current === participant.identity);
      room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
        if (!isCurrentRoom() || reconnectingRef.current || topic !== VOICE_UI_TOPIC || !isTrustedAgent(participant)) return;
        const message = parseVoiceUiMessage(payload);
        if (!message || !participant) return;
        agentIdentityRef.current ??= participant.identity;
        dispatchTranscript({ type: 'receive', message, senderIdentity: participant.identity, isAgent: true });
      });
      room.on(RoomEvent.Reconnecting, () => {
        if (!isCurrentRoom()) return;
        reconnectingRef.current = true;
        resetTranscript();
        setPlaybackStatus('waiting');
      });
      room.on(RoomEvent.Reconnected, () => {
        if (!isCurrentRoom()) return;
        resetTranscript();
        reconnectingRef.current = false;
      });
      room.on(RoomEvent.Disconnected, () => {
        if (!isCurrentRoom()) return;
        void stop();
      });
      const subscribeToAudio = (publication: RemoteTrackPublication) => {
        if (publication.kind !== 'audio') return;
        setPlaybackStatus('participant');
        if (!publication.isSubscribed) publication.setSubscribed(true);
      };
      room.on(RoomEvent.ParticipantConnected, (participant) => {
        if (!isCurrentRoom() || !isTrustedAgent(participant)) return;
        setPlaybackStatus('participant');
        participant.audioTrackPublications.forEach(subscribeToAudio);
      });
      room.on(RoomEvent.TrackPublished, (publication, participant) => {
        if (isCurrentRoom() && isTrustedAgent(participant)) subscribeToAudio(publication);
      });
      room.on(RoomEvent.TrackSubscriptionFailed, (_trackSid, error) => {
        console.warn('[voice] remote audio subscription failed', error);
        setPlaybackStatus('blocked');
        setErrorMessage(t('voice.audioSubscriptionFailed'));
      });
      room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _publication, participant) => {
        if (!isCurrentRoom() || !isTrustedAgent(participant) || track.kind !== 'audio') return;
        setPlaybackStatus('track');
        const audio = remoteAudioRef.current;
        if (!audio) return;
        track.attach(audio);
        audio.autoplay = true;
        audio.muted = false;
        audio.volume = 1;
        audio.onplaying = () => { if (isCurrentRoom()) { setAudioPlaying(true); setPlaybackStatus('playing'); } };
        const notPlaying = () => { if (isCurrentRoom()) setAudioPlaying(false); };
        audio.onpause = notPlaying;
        audio.onwaiting = notPlaying;
        audio.onstalled = notPlaying;
        audio.onended = notPlaying;
        audio.onerror = () => { if (isCurrentRoom()) { setAudioPlaying(false); setPlaybackStatus('blocked'); } };
        void room.startAudio()
          .then(() => audio.play())
          .then(() => {
            if (!isCurrentRoom()) return;
            setPlaybackBlocked(false);
            setErrorMessage('');
          })
          .catch((playError) => {
            if (!isCurrentRoom()) return;
            setAudioPlaying(false);
            console.warn('[voice] remote audio autoplay blocked', playError);
            setPlaybackBlocked(true);
            setPlaybackStatus('blocked');
            setErrorMessage(t('voice.enablePlaybackHint'));
          });
      });
      room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _publication, participant) => {
        if (!isCurrentRoom() || !isTrustedAgent(participant) || track.kind !== 'audio') return;
        setAudioPlaying(false);
        setPlaybackStatus('waiting');
        track.detach();
        if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
        setState('listening');
      });
      room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        if (!isCurrentRoom()) return;
        const remoteSpeaking = speakers.some((speaker) => speaker.isAgent && (!agentIdentityRef.current || speaker.identity === agentIdentityRef.current));
        setState((current) => current === 'error' || current === 'connecting' ? current : remoteSpeaking ? 'speaking' : 'listening');
      });
      await room.connect(result.livekit.url, result.livekit.token, { autoSubscribe: true });
      if (!isCurrentRoom()) return;
      connectStage = t('voice.stage.microphone');
      const recoverRemoteAudio = () => {
        if (!isCurrentRoom() || reconnectingRef.current) return;
        room.remoteParticipants.forEach((participant) => {
          if (!isTrustedAgent(participant)) return;
          setPlaybackStatus('participant');
          participant.audioTrackPublications.forEach((publication) => {
            subscribeToAudio(publication);
            if (!publication.track || publication.track.kind !== 'audio') return;
            const audio = remoteAudioRef.current;
            if (!audio) return;
            setPlaybackStatus('track');
            publication.track.attach(audio);
            audio.muted = false;
            audio.volume = 1;
            void audio.play()
              .then(() => { if (isCurrentRoom()) setPlaybackStatus('playing'); })
              .catch(() => { if (isCurrentRoom()) { setAudioPlaying(false); setPlaybackStatus('blocked'); } });
          });
        });
      };
      recoverRemoteAudio();
      subscriptionTimerRef.current = window.setInterval(recoverRemoteAudio, 500);
      await room.startAudio();
      room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
        if (!isCurrentRoom()) return;
        if (!room.canPlaybackAudio) setAudioPlaying(false);
        setPlaybackBlocked(!room.canPlaybackAudio);
        if (!room.canPlaybackAudio) setErrorMessage(t('voice.enablePlaybackHint'));
      });
      const microphonePublication = await room.localParticipant.setMicrophoneEnabled(true, {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
      if (!isCurrentRoom()) return;
      const microphone = microphonePublication?.audioTrack as LocalAudioTrack | undefined;
      if (!microphonePublication || !microphone || microphonePublication.isMuted) throw new Error(t('voice.microphonePublishFailed'));
      setMicrophonePublished(true);

      const audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.72;
      const source = audioContext.createMediaStreamSource(new MediaStream([microphone.mediaStreamTrack]));
      source.connect(analyser);
      const samples = new Uint8Array(analyser.frequencyBinCount);
      const updateMeter = () => {
        analyser.getByteFrequencyData(samples);
        const voiceBand = samples.slice(1, 28);
        const average = voiceBand.reduce((sum, value) => sum + value, 0) / Math.max(1, voiceBand.length);
        setAudioLevel(Math.min(1, average / 110));
        meterFrameRef.current = requestAnimationFrame(updateMeter);
      };
      audioContextRef.current = audioContext;
      updateMeter();

      setState('listening');
    } catch (error) {
      if (!isCurrent()) return;
      console.error('[voice] connection failed', { stage: connectStage, error });
      const detail = error instanceof Error ? error.message : t('voice.unknownError');
      const message = t('voice.stageFailed', { stage: connectStage, detail });
      await stop();
      setErrorMessage(message);
      setState('error');
    }
  };

  const enablePlayback = async () => {
    const room = roomRef.current;
    const audio = remoteAudioRef.current;
    if (!room || !audio) return;
    try {
      const roomPlayback = room.startAudio();
      const elementPlayback = audio.play();
      await Promise.all([roomPlayback, elementPlayback]);
      if (roomRef.current !== room) return;
      setPlaybackStatus('playing');
      setPlaybackBlocked(false);
      setErrorMessage('');
    } catch (error) {
      if (roomRef.current !== room) return;
      setAudioPlaying(false);
      console.warn('[voice] explicit audio playback failed', error);
      setErrorMessage(t('voice.speakerPlaybackFailed'));
    }
  };

  const testSpeaker = async () => {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 660;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.35);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.36);
    await new Promise((resolve) => setTimeout(resolve, 420));
    await context.close();
  };

  const active = state === 'listening' || state === 'speaking';
  const bars = [0.45, 0.8, 1, 0.68, 0.38];
  return (
    <div className="relative self-end">
    <button
      type="button"
      onClick={playbackBlocked ? enablePlayback : active ? stop : start}
      disabled={!sessionId || state === 'connecting'}
      aria-label={playbackBlocked ? t('voice.enableAiPlayback') : active ? t('voice.endConversation') : t('voice.startConversation')}
      title={state === 'error' ? errorMessage || t('voice.connectionFailed') : active ? t('voice.endConversation') : t('voice.talkWithSeojun')}
      className={`inline-flex min-h-12 min-w-32 touch-manipulation items-center justify-center gap-2 rounded-xl px-5 text-base font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        active
          ? 'bg-red-500/15 text-red-700 hover:bg-red-500/25 dark:text-red-200'
          : 'bg-surface-800 text-surface-100 hover:bg-surface-700'
      }`}
    >
      {state === 'connecting' ? (
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden="true" />
      ) : active ? (
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M9 9v3a3 3 0 0 0 5.1 2.1M15 9V5a3 3 0 0 0-6 0"/><path d="M5 10v2a7 7 0 0 0 11.7 5.2M12 19v3M8 22h8M3 3l18 18"/></svg>
      ) : (
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>
      )}
      {active && (
        <span className="flex h-4 items-center gap-0.5" aria-hidden="true">
          {bars.map((weight, index) => (
            <span
              key={index}
              className="h-4 w-0.5 origin-center rounded-full bg-current transition-transform duration-75 motion-reduce:transition-none"
              style={{ transform: `scaleY(${Math.max(0.2, 0.2 + audioLevel * 0.8 * weight)})` }}
            />
          ))}
        </span>
      )}
      <span>{state === 'connecting' ? t('voice.connecting') : playbackBlocked ? t('voice.enableSound') : state === 'speaking' ? t('voice.answering') : active ? t('voice.listening') : state === 'error' ? t('voice.reconnect') : t('voice.conversation')}</span>
    </button>
    {(active || state === 'connecting' || state === 'error') && (
      <div className={`absolute bottom-full right-0 z-20 mb-2 w-[min(24rem,calc(100vw-2rem))] whitespace-normal rounded-lg border px-4 py-3 text-xs shadow-lg [overflow-wrap:anywhere] [word-break:keep-all] ${
        state === 'error'
          ? 'border-red-500/25 bg-surface-900 text-red-300'
          : 'border-primary-500/20 bg-surface-900 text-surface-100'
      }`}>
        <div role="status" aria-live="polite">
        {state === 'connecting' && t('voice.connectingToSeojun')}
        {state === 'listening' && (errorMessage || (!microphonePublished ? t('voice.checkingMicrophone') : audioLevel > 0.08 ? t('voice.sendingMicrophoneAudio') : t('voice.microphoneReady')))}
        {state === 'speaking' && t('voice.seojunAnswering')}
        </div>
        {active && (
          <div className="mt-1 flex items-center gap-2 border-t border-surface-700 pt-1 text-[11px] text-surface-300">
            <span>{t('voice.output', { status: t(`voice.playback.${playbackStatus}`) })}</span>
            <button type="button" className="underline hover:text-surface-100" onClick={(event) => { event.stopPropagation(); void testSpeaker(); }}>{t('voice.testSpeaker')}</button>
          </div>
        )}
        {state === 'error' && <p role="alert">{t('voice.connectionFailureDetail', { detail: errorMessage || t('voice.checkSettings') })}</p>}
        {active && <VoiceLiveTranscript transcript={transcript} audioPlaying={audioPlaying && !playbackBlocked} />}
      </div>
    )}
      <audio ref={remoteAudioRef} autoPlay playsInline className="absolute h-px w-px opacity-0" aria-hidden="true" />
    </div>
  );
}
