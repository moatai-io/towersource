import { describe, expect, it } from 'vitest';
import { createVoiceTurnTelemetry } from './voice-turn-telemetry.js';
import { createVoiceSdkTimingObserver } from '../../engines/pi/voice-timing-observer.js';

describe('value-free correlated latency measurements', () => {
  it('keeps exact elapsed milestones while stripping all content/config/error fields', () => {
    let now = 1000;
    const rows: any[] = [];
    const emit = createVoiceTurnTelemetry({ turnId: 'turn-fixture', revision: 3 }, {
      now: () => now, write: (line) => rows.push(JSON.parse(line.slice('[voice-latency] '.length))),
    });
    emit({ stage: 'gateway_received', text: 'DO_NOT_LOG', token: 'DO_NOT_LOG', error: 'DO_NOT_LOG' } as any);
    now = 1120;
    emit({ stage: 'engine_model_ready', model: 'litellm-responses/smartest', effort: 'high', contextWindow: 100000, messageCount: 10, apiKey: 'DO_NOT_LOG' } as any);
    emit({ stage: 'engine_model_ready', model: 'duplicate' });
    now = 1300;
    emit({ stage: 'sdk_first_text', source: 'text_delta', model: 'https://private.example/key?token=DO_NOT_LOG' });
    expect(rows).toEqual([
      { turnId: 'turn-fixture', revision: 3, stage: 'gateway_received', elapsedMs: 0 },
      { turnId: 'turn-fixture', revision: 3, stage: 'engine_model_ready', elapsedMs: 120, model: 'litellm-responses/smartest', effort: 'high', contextWindow: 100000, messageCount: 10 },
      { turnId: 'turn-fixture', revision: 3, stage: 'sdk_first_text', elapsedMs: 300, source: 'text_delta' },
    ]);
    expect(JSON.stringify(rows)).not.toContain('DO_NOT_LOG');
  });
  it('distinguishes early unknown/commentary text from late confirmed final phase', () => {
    let now = 0;
    const rows: any[] = [];
    const emit = createVoiceTurnTelemetry({ turnId: 'turn-fixture', revision: 1 }, { now: () => now, write: (line) => rows.push(JSON.parse(line.slice(16))) });
    const observe = createVoiceSdkTimingObserver(emit);
    const delta = (phase?: string, type = 'text_delta') => ({ type: 'message_update', assistantMessageEvent: {
      type, contentIndex: 0, delta: 'PRIVATE', partial: { content: [{ type: 'text', text: '답변', ...(phase ? { textSignature: JSON.stringify({ phase }) } : {}) }] },
    } });
    now = 100; observe({ type: 'agent_start', secret: 'PRIVATE' });
    now = 1000; observe(delta());
    now = 1100; observe(delta('commentary'));
    now = 10000; observe(delta('final_answer', 'text_end'));
    now = 10100; observe(delta('final_answer'));
    expect(rows.find((r) => r.stage === 'sdk_first_unknown_text')).toMatchObject({ elapsedMs: 1000, source: 'text_delta' });
    expect(rows.find((r) => r.stage === 'sdk_first_final_phase')).toMatchObject({ elapsedMs: 10000, source: 'text_end' });
    expect(rows.find((r) => r.stage === 'sdk_first_eligible_text')).toMatchObject({ elapsedMs: 10000 });
    expect(rows.filter((r) => r.stage === 'sdk_first_text')).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('PRIVATE');
  });
  it('marks tool work and provider input usage separately without content', () => {
    const seen: any[] = [];
    const observe = createVoiceSdkTimingObserver((event) => seen.push(event));
    observe({ type: 'tool_execution_start', toolName: 'private-tool', args: { token: 'PRIVATE' } });
    observe({ type: 'message_end', message: { role: 'assistant', content: [], usage: { input: 100, cacheRead: 200, cacheWrite: 20, output: 50 } } });
    expect(seen).toContainEqual({ stage: 'sdk_first_tool' });
    expect(seen).toContainEqual({ stage: 'sdk_first_usage', contextInputTokens: 320 });
    expect(JSON.stringify(seen)).not.toMatch(/PRIVATE|private-tool/);
  });
});
