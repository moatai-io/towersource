import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const input = fs.readFileSync(path.resolve(import.meta.dirname, './InputBox.tsx'), 'utf8');
const runtime = fs.readFileSync(path.resolve(import.meta.dirname, '../../hooks/useChatRuntime.ts'), 'utf8');
const app = fs.readFileSync(path.resolve(import.meta.dirname, '../../App.tsx'), 'utf8');

describe('immediate stop UI contract', () => {
  it('offers one immediate stop action for an active Pi turn', () => {
    expect(input).toContain("const isSafeStopAvailable = isPiStreamingSession");
    expect(input).toContain('isSafeStopAvailable && onSafeStop');
    expect(input).not.toMatch(/const isPiStreamingSession[^;]*modelUsed/);
    expect(input).toContain("title={t('stopImmediately')}");
    expect(input).toContain("aria-label={t('stopImmediately')}");
    expect(input).not.toContain('마치는 중…');
    expect(input).not.toContain('지금 하는 작업을 마치고 멈춥니다');
    expect(input).toContain('focus-visible:ring-primary-400');
  });

  it('sends force-stop and optimistically marks the turn idle', () => {
    expect(runtime).toContain("type: 'request_turn_stop'");
    expect(runtime).toContain("mode: 'force'");
    expect(runtime).toMatch(/const requestSafeStop[\s\S]*setStreaming\(false\)/);
    expect(runtime).toMatch(/const requestSafeStop[\s\S]*markSessionRunFinished\(sessionId, 'stopped'/);
    expect(app).toContain('onSafeStop={requestSafeStop}');
  });
});
