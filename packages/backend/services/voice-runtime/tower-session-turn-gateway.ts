/** Owns: adapting a voice transcript into Tower's existing durable chat turn path. */
import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { handleChat } from '../../routes/ws-handler.js';
import { getMessages } from '../message-store.js';
import { getSession } from '../session/session-manager.js';
import { extractTextFromContent } from '../../utils/text.js';
import { getActiveAgentTurnTiming, rejectAgentTurnStopRequest, requestAgentTurnStop } from '../agent-turn/turn-supervisor.js';
import { getEngine } from '../../engines/index.js';
import { queryOne } from '../../db/pg-repo.js';
const activeVoiceTurns = new Set<string>();
const VOICE_SESSION_BUSY_RESPONSE = '지금 이 대화의 이전 음성 답변을 마무리하고 있어요. 끝나면 다시 말씀해 주세요.';

/** Request the in-process Tower engine to stop the active voice turn at its safe boundary. */
export async function requestVoiceTurnCancellation(sessionId: string): Promise<boolean> {
  const active = await getActiveAgentTurnTiming(sessionId).catch(() => null);
  if (!active || !['running', 'waiting_retry', 'stop_requested'].includes(active.state)) return false;
  const requested = await requestAgentTurnStop({ rootTurnId: active.rootTurnId, mode: 'safe' }).catch(() => false);
  if (!requested) return false;
  const engine = await getEngine('pi').catch(() => null);
  if (!engine?.requestStopAtBoundary) {
    await rejectAgentTurnStopRequest({ rootTurnId: active.rootTurnId, error: 'Pi safe-stop capability is unavailable.' }).catch(() => {});
    return false;
  }
  const result = await engine.requestStopAtBoundary(sessionId).catch(() => ({ accepted: false }));
  if (!result.accepted) {
    await rejectAgentTurnStopRequest({ rootTurnId: active.rootTurnId, error: 'Pi safe-stop request was not accepted.' }).catch(() => {});
    return false;
  }
  return true;
}

/** Run one transcript through the normal Tower Session engine, storage, tools, and callbacks. */
export async function runTowerVoiceTurn(input: { sessionId: string; userId: number; transcript: string }): Promise<string> {
  if (activeVoiceTurns.has(input.sessionId)) return VOICE_SESSION_BUSY_RESPONSE;
  activeVoiceTurns.add(input.sessionId);
  try {
    return await runExclusiveTowerVoiceTurn(input);
  } finally {
    activeVoiceTurns.delete(input.sessionId);
  }
}

async function runExclusiveTowerVoiceTurn(input: { sessionId: string; userId: number; transcript: string }): Promise<string> {
  const session = await getSession(input.sessionId);
  if (!session) throw new Error('Tower Session not found');
  const idleDeadline = Date.now() + 15_000;
  while (Date.now() < idleDeadline) {
    const active = await getActiveAgentTurnTiming(input.sessionId).catch(() => null);
    if (!active || !['running', 'stop_requested', 'waiting_retry'].includes(active.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const stillActive = await getActiveAgentTurnTiming(input.sessionId).catch(() => null);
  if (stillActive && ['running', 'stop_requested', 'waiting_retry'].includes(stillActive.state)) {
    return VOICE_SESSION_BUSY_RESPONSE;
  }
  const before = await getMessages(input.sessionId);
  const beforeIds = new Set(before.map((message) => message.id));
  const actor = await queryOne<{ username: string; role: string }>(
    'SELECT username, role FROM users WHERE id = $1',
    [input.userId],
  );
  const sink = { readyState: WebSocket.OPEN, send() {} } as unknown as WebSocket;
  await handleChat({
    id: `voice-${uuidv4()}`,
    ws: sink,
    sessionId: input.sessionId,
    userId: input.userId,
    username: actor?.username || 'voice',
    userRole: actor?.role || 'member',
    activeQueryEpoch: 0,
    joinedRooms: new Set(),
  }, {
    type: 'chat',
    sessionId: input.sessionId,
    message: input.transcript,
    messageId: uuidv4(),
    model: 'litellm-responses/mini',
    effort: 'low',
    headless: true,
    voiceMode: true,
    suppressUserEcho: false,
  } as any);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const after = await getMessages(input.sessionId);
    const assistant = after.filter((message) => !beforeIds.has(message.id) && message.role === 'assistant').at(-1);
    if (assistant) {
      const text = extractTextFromContent(assistant.content).trim();
      if (text) return text;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Tower Agent response timed out');
}
