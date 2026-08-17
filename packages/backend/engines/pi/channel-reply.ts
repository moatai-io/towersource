// Owns persistent @ai channel reply adaptation for Pi sessions.
// Public API: channelReplyWithPiRun.

import type { ChannelReplyOpts, ChannelReplyResult, EngineCallbacks, RunOpts, TowerContentBlock, TowerMessage } from '../types.js';

export async function channelReplyWithPiRun(params: {
  prompt: string;
  opts: ChannelReplyOpts;
  run: (sessionId: string, prompt: string, opts: RunOpts, callbacks: EngineCallbacks) => AsyncGenerator<TowerMessage>;
  dispose: (sessionId: string) => void;
}): Promise<ChannelReplyResult> {
  const { prompt, opts, run, dispose } = params;

  // Pi native resume is bound to the immutable Harness snapshot on the stable
  // Tower channel Session. Use that same id for run(), not a per-call synthetic
  // id; otherwise strict resume looks for a snapshot that can never exist.
  // PiEngine already serializes/races a session id safely, and dispose() removes
  // only the in-memory runtime after this reply.
  const logicalChannelId = opts.roomSessionId || opts.resumeSessionId || 'channel-pi-room-unknown';
  const internalSessionId = logicalChannelId;
  let fullContent = '';
  let engineSessionId: string | undefined = opts.resumeSessionId;
  const tools: Array<{ name: string; input?: Record<string, unknown> }> = [];

  // Map ChannelReplyOpts → RunOpts. Channel AI runs with full tool access — same
  // surface as a regular session. Tool guarding happens inside run().
  const homeDir = process.env.HOME || '/home/tower';
  const runOpts: RunOpts = {
    cwd: opts.cwd || `${homeDir}/workspace`,
    model: opts.model,
    logicalSessionId: logicalChannelId,
    userId: opts.userId,
    username: opts.username,
    userRole: opts.userRole || 'member',
    allowedPath: opts.allowedPath,
    accessiblePaths: opts.accessiblePaths,
    readOnlyPaths: opts.readOnlyPaths,
    denyImplicitBash: opts.denyImplicitBash,
    channelSafeToolsOnly: opts.channelSafeToolsOnly,
    sessionProjectRoot: opts.sessionProjectRoot,
    projectId: opts.projectId,
    engineSessionId: opts.resumeSessionId,
  };

  // Stub callbacks — channel AI message persistence is handled by ai-quick-reply
  // (it owns the channel session row + room message). We still need
  // claimSessionId so we capture the new Pi sessionFile path for next resume.
  const callbacks: EngineCallbacks = {
    askUser: async () =>
      'Channel AI has no interactive prompt UI — make a reasonable assumption and state it in your reply.',
    claimSessionId: async (engSid: string) => {
      if (engSid) engineSessionId = engSid;
    },
    saveMessage: async () => {},
    updateMessageContent: async () => {},
    attachToolResult: async () => {},
    updateMessageMetrics: async () => {},
  };

  try {
    for await (const towerMsg of run(internalSessionId, prompt, runOpts, callbacks)) {
      if (towerMsg.type === 'assistant') {
        for (const block of (towerMsg.content || []) as TowerContentBlock[]) {
          if (block.type === 'tool_use' && block.name) {
            const input = block.input as Record<string, unknown> | undefined;
            tools.push({ name: block.name, input });
            opts.onToolUse?.(block.name, input);
          }
        }
        const currentText = (towerMsg.content || [])
          .filter((b: TowerContentBlock): b is TowerContentBlock & { type: 'text' } => b.type === 'text')
          .map((b) => b.text || '')
          .join('');
        if (currentText && currentText.length > fullContent.length) {
          const chunk = currentText.slice(fullContent.length);
          fullContent = currentText;
          opts.onChunk(chunk, fullContent);
        }
      } else if (towerMsg.type === 'compact') {
        opts.onCompact?.(towerMsg.phase);
      } else if (towerMsg.type === 'engine_done') {
        if (towerMsg.engineSessionId) engineSessionId = towerMsg.engineSessionId;
      } else if (towerMsg.type === 'engine_error' && !towerMsg.recoverable) {
        throw new Error(towerMsg.message);
      }
    }
  } finally {
    try {
      dispose(internalSessionId);
    } catch (err) {
      console.warn(`[Pi] channelReply dispose failed for ${internalSessionId.slice(0, 8)}:`, err);
    }
  }

  return {
    content: fullContent,
    engineSessionId,
    provenance: {
      authorityFingerprint: opts.authorityFingerprint || '',
      tools,
    },
  };
}
