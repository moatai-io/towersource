import { useEffect } from 'react';
import { useChatStore } from '../../stores/chat-store';
import { useSessionStore } from '../../stores/session-store';
import { useSpeechSession } from './answer-speech-session';
import { useAnswerVoice } from './AnswerVoiceToggle';
import { getAnswerSpeechPlayer } from './answer-speech-player';
const announced = new Set<string>();
export function ToolStartVoiceCue({ sessionId }: { sessionId: string | null }) {
  const messages = useChatStore(s => s.messages);
  const streaming = useChatStore(s => s.isStreaming);
  const enabledAt = useAnswerVoice(s => sessionId ? s.enabledAt[sessionId] || 0 : 0);
  const recording = useSpeechSession(s => !!(sessionId && s.recording[sessionId]));
  const owner = useSpeechSession(s => s.owner);
  useEffect(() => {
    if (!sessionId || !enabledAt || !streaming || recording || owner || document.hidden || useSessionStore.getState().activeSessionId !== sessionId) return;
    const userIndex = messages.findLastIndex(m => m.role === 'user');
    const user = messages[userIndex];
    if (!user || user.timestamp < enabledAt) return;
    const replies = messages.slice(userIndex + 1);
    if (!replies.some(m => m.content.some(b => b.type === 'tool_use' && b.toolUse?.result === undefined))) return;
    const key = `${sessionId}:${user.id}`;
    if (announced.has(key)) return;
    announced.add(key);
    const player = getAnswerSpeechPlayer();
    // Never take over an already playing answer.
    if (!player.paused) return;
    player.onended = null; player.onerror = null; player.ontimeupdate = null;
    player.src = '/audio/tool-start-ko.mp3'; player.playbackRate = 1.2; player.preservesPitch = true;
    void player.play().catch(() => {});
  }, [sessionId, enabledAt, streaming, recording, owner, messages]);
  useEffect(() => {
    const player = getAnswerSpeechPlayer();
    const stop = () => { if (player.src.endsWith('/audio/tool-start-ko.mp3')) player.pause(); };
    const hide = () => { if (document.hidden) stop(); };
    window.addEventListener('tower-speech-stop', stop);
    window.addEventListener('tower-speech-question', stop);
    window.addEventListener('tower-speech-recording', stop);
    document.addEventListener('visibilitychange', hide);
    return () => { stop(); window.removeEventListener('tower-speech-stop', stop); window.removeEventListener('tower-speech-question', stop); window.removeEventListener('tower-speech-recording', stop); document.removeEventListener('visibilitychange', hide); };
  }, [sessionId, enabledAt, recording, owner]);
  return null;
}
