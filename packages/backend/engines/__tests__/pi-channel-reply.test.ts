import { describe, expect, it, vi } from 'vitest';
import { channelReplyWithPiRun } from '../pi/channel-reply.js';
import type { EngineCallbacks, RunOpts, TowerMessage } from '../types.js';

async function* fakeRun(messages: TowerMessage[]) {
  for (const message of messages) yield message;
}

describe('Pi channel reply adapter', () => {
  it('converts cumulative assistant text into delta chunks', async () => {
    const chunks: Array<{ chunk: string; full: string }> = [];

    const result = await channelReplyWithPiRun({
      prompt: 'hello',
      opts: {
        model: 'openrouter/test',
        onChunk: (chunk, full) => chunks.push({ chunk, full }),
      },
      run: (_sessionId: string, _prompt: string, _opts: RunOpts, _callbacks: EngineCallbacks) => fakeRun([
        { type: 'assistant', sessionId: 's', content: [{ type: 'text', text: '안녕' }], timestamp: 1 },
        { type: 'assistant', sessionId: 's', content: [{ type: 'text', text: '안녕하세요' }], timestamp: 2 },
        { type: 'engine_done', sessionId: 's', engineSessionId: '/tmp/pi-session.jsonl' },
      ]),
      dispose: () => {},
    });

    expect(chunks).toEqual([
      { chunk: '안녕', full: '안녕' },
      { chunk: '하세요', full: '안녕하세요' },
    ]);
    expect(result).toEqual({
      content: '안녕하세요',
      engineSessionId: '/tmp/pi-session.jsonl',
      provenance: { authorityFingerprint: '', tools: [] },
    });
  });

  it('forwards tool and compaction status callbacks', async () => {
    const tools: string[] = [];
    const compactPhases: string[] = [];

    const result = await channelReplyWithPiRun({
      prompt: 'work',
      opts: {
        model: 'openrouter/test',
        authorityFingerprint: 'authority-v1',
        onChunk: () => {},
        onToolUse: (name) => tools.push(name),
        onCompact: (phase) => compactPhases.push(phase),
      },
      run: () => fakeRun([
        { type: 'assistant', sessionId: 's', content: [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }], timestamp: 1 },
        { type: 'compact', sessionId: 's', phase: 'compacting', timestamp: 2 },
        { type: 'compact', sessionId: 's', phase: 'failed', timestamp: 3 },
        { type: 'engine_done', sessionId: 's' },
      ]),
      dispose: () => {},
    });

    expect(tools).toEqual(['bash']);
    expect(compactPhases).toEqual(['compacting', 'failed']);
    expect(result.provenance).toEqual({ authorityFingerprint: 'authority-v1', tools: [{ name: 'bash', input: {} }] });
  });

  it('runs and disposes with the stable Tower channel Session id for Harness resume continuity', async () => {
    const run = vi.fn((_sessionId: string, _prompt: string, _opts: RunOpts, _callbacks: EngineCallbacks) =>
      fakeRun([{ type: 'engine_done', sessionId: 'channel-session' }]),
    );
    const dispose = vi.fn();

    await channelReplyWithPiRun({
      prompt: 'resume',
      opts: {
        roomSessionId: 'channel-session',
        projectId: 'project-1',
        resumeSessionId: '/tmp/channel.jsonl',
        model: 'openrouter/test',
        onChunk: () => {},
      },
      run,
      dispose,
    });

    expect(run).toHaveBeenCalledWith(
      'channel-session',
      'resume',
      expect.objectContaining({ projectId: 'project-1', engineSessionId: '/tmp/channel.jsonl' }),
      expect.any(Object),
    );
    expect(dispose).toHaveBeenCalledWith('channel-session');
  });

  it('throws non-recoverable engine errors and always disposes the internal session', async () => {
    const dispose = vi.fn();

    await expect(channelReplyWithPiRun({
      prompt: 'boom',
      opts: {
        model: 'openrouter/test',
        onChunk: () => {},
      },
      run: () => fakeRun([
        { type: 'engine_error', sessionId: 's', message: 'fatal', recoverable: false },
      ]),
      dispose,
    })).rejects.toThrow('fatal');

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledWith('channel-pi-room-unknown');
  });

  it('disposes the internal session after successful completion', async () => {
    const dispose = vi.fn();

    await channelReplyWithPiRun({
      prompt: 'ok',
      opts: {
        model: 'openrouter/test',
        onChunk: () => {},
      },
      run: () => fakeRun([{ type: 'engine_done', sessionId: 's' }]),
      dispose,
    });

    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
