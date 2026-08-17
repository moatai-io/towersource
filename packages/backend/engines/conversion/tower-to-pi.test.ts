import { describe, it, expect } from 'vitest';
import { convertOneTowerMessageToPi, convertTowerMessagesToPi } from './tower-to-pi.js';
import type { RehydrateInputMessage } from '../types.js';

const T0 = 1_700_000_000_000;

function userMsg(content: any[], id = 'u-1', timestamp = T0): RehydrateInputMessage {
  return { id, role: 'user', content, timestamp };
}
function assistantMsg(content: any[], id = 'a-1', timestamp = T0 + 1000): RehydrateInputMessage {
  return { id, role: 'assistant', content, timestamp };
}

describe('convertOneTowerMessageToPi — user side', () => {
  it('plain text user message → single UserMessage with array content', () => {
    const out = convertOneTowerMessageToPi(userMsg([{ type: 'text', text: '안녕하세요' }]));
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: '안녕하세요' }],
      timestamp: T0,
    });
  });

  it('drops empty text blocks instead of producing UserMessage with []', () => {
    const out = convertOneTowerMessageToPi(userMsg([{ type: 'text', text: '' }]));
    // No surviving content → no UserMessage emitted at all.
    expect(out).toEqual([]);
  });

  it('single tool_result (string content) → ToolResultMessage only', () => {
    const out = convertOneTowerMessageToPi(userMsg([
      { type: 'tool_result', tool_use_id: 'toolu_abc', content: 'ok', is_error: false },
    ]));
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      role: 'toolResult',
      toolCallId: 'toolu_abc',
      toolName: '',
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
      timestamp: T0,
    });
  });

  it('tool_result with array content (text + image base64) preserves both', () => {
    const out = convertOneTowerMessageToPi(userMsg([
      {
        type: 'tool_result',
        tool_use_id: 'toolu_x',
        content: [
          { type: 'text', text: 'screenshot:' },
          { type: 'image', source: { type: 'base64', data: 'AAA=', media_type: 'image/png' } },
        ],
      },
    ]));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'toolu_x',
      content: [
        { type: 'text', text: 'screenshot:' },
        { type: 'image', data: 'AAA=', mimeType: 'image/png' },
      ],
    });
  });

  it('sanitizes embedded base64 when rehydrating a textual tool result', () => {
    const payload = 'A'.repeat(9000);
    const out = convertOneTowerMessageToPi(userMsg([
      { type: 'tool_result', tool_use_id: 'svg-read', content: `<svg><image href="data:image/png;base64,${payload}"/></svg>` },
    ]));
    expect(out[0]).toMatchObject({
      role: 'toolResult',
      content: [{ type: 'text', text: expect.stringContaining('[embedded binary omitted: image/png') }],
    });
    expect(JSON.stringify(out)).not.toContain(payload);
  });

  it('multiple tool_result blocks on one row → expanded to N ToolResultMessages (Pi keeps them separate)', () => {
    const out = convertOneTowerMessageToPi(userMsg([
      { type: 'tool_result', tool_use_id: 't1', content: 'r1' },
      { type: 'tool_result', tool_use_id: 't2', content: 'r2' },
    ]));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ role: 'toolResult', toolCallId: 't1' });
    expect(out[1]).toMatchObject({ role: 'toolResult', toolCallId: 't2' });
  });

  it('tool_result + trailing user text → N tool results THEN a UserMessage', () => {
    const out = convertOneTowerMessageToPi(userMsg([
      { type: 'tool_result', tool_use_id: 't1', content: 'r1' },
      { type: 'text', text: '계속해줘' },
    ]));
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe('toolResult');
    expect(out[1].role).toBe('user');
    if (out[1].role === 'user') {
      expect(out[1].content).toEqual([{ type: 'text', text: '계속해줘' }]);
    }
  });

  it('image block with blob_ref source → text placeholder (Phase 1 lossy)', () => {
    const out = convertOneTowerMessageToPi(userMsg([
      { type: 'image', source: { type: 'blob_ref', path: 'abc123.png', media_type: 'image/png' } },
    ]));
    expect(out).toHaveLength(1);
    if (out[0].role === 'user' && Array.isArray(out[0].content)) {
      expect(out[0].content[0]).toMatchObject({
        type: 'text',
        text: expect.stringContaining('abc123.png'),
      });
    }
  });

  it('image block with small inline base64 → real ImageContent', () => {
    const out = convertOneTowerMessageToPi(userMsg([
      { type: 'image', source: { type: 'base64', data: 'AAAA', media_type: 'image/jpeg' } },
    ]), { sessionFilePath: '/tmp/session.jsonl' });
    if (out[0].role === 'user' && Array.isArray(out[0].content)) {
      expect(out[0].content[0]).toEqual({
        type: 'image',
        data: 'AAAA',
        mimeType: 'image/jpeg',
      });
    }
  });

  it('omits incident-sized inline images from a rehydrated Pi session', () => {
    const payload = Buffer.alloc(1024 * 1024 + 1).toString('base64');
    const out = convertOneTowerMessageToPi(userMsg([
      { type: 'image', source: { type: 'base64', data: payload, media_type: 'image/png' } },
    ]), { sessionFilePath: '/tmp/session.jsonl' });
    expect(JSON.stringify(out)).not.toContain(payload);
    expect(out[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: expect.stringContaining('omitted from rehydrated session') }],
    });
  });

  it('omits incident-sized tool-result images when rehydrating', () => {
    const payload = Buffer.alloc(1024 * 1024 + 1).toString('base64');
    const out = convertOneTowerMessageToPi(userMsg([{
      type: 'tool_result', tool_use_id: 'shot', content: [
        { type: 'image', source: { type: 'base64', data: payload, media_type: 'image/png' } },
      ],
    }]), { sessionFilePath: '/tmp/session.jsonl' });
    expect(JSON.stringify(out)).not.toContain(payload);
    expect(out[0]).toMatchObject({
      role: 'toolResult',
      content: [{ type: 'text', text: expect.stringContaining('omitted from rehydrated session') }],
    });
  });

  it('keeps a 1MB inline image inline for compatibility', () => {
    const payload = 'A'.repeat(Math.ceil(1024 * 1024 * 4 / 3));
    const out = convertOneTowerMessageToPi(userMsg([
      { type: 'image', source: { type: 'base64', data: payload, media_type: 'image/png' } },
    ]));
    expect(out[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'image', data: payload, mimeType: 'image/png' }],
    });
  });

  it('unknown block types are dropped silently (consistent with lossy contract)', () => {
    const out = convertOneTowerMessageToPi(userMsg([
      { type: 'text', text: 'keep me' },
      { type: 'future_block_type_we_dont_know', payload: '???' },
    ]));
    expect(out).toHaveLength(1);
    if (out[0].role === 'user' && Array.isArray(out[0].content)) {
      expect(out[0].content).toEqual([{ type: 'text', text: 'keep me' }]);
    }
  });
});

describe('convertOneTowerMessageToPi — assistant side', () => {
  it('plain text → AssistantMessage with placeholder metadata', () => {
    const out = convertOneTowerMessageToPi(assistantMsg([{ type: 'text', text: '답변입니다' }]));
    expect(out).toHaveLength(1);
    if (out[0].role === 'assistant') {
      expect(out[0].content).toEqual([{ type: 'text', text: '답변입니다' }]);
      expect(out[0].model).toBe('rehydrated');
      expect(out[0].stopReason).toBe('stop');
      expect(out[0].usage.totalTokens).toBe(0);
      expect(out[0].timestamp).toBe(T0 + 1000);
    }
  });

  it('tool_use block → toolCall with id/name/arguments preserved verbatim', () => {
    const out = convertOneTowerMessageToPi(assistantMsg([
      { type: 'text', text: '도구 호출합니다' },
      { type: 'tool_use', id: 'toolu_42', name: 'Bash', input: { command: 'ls' } },
    ]));
    if (out[0].role === 'assistant') {
      expect(out[0].content).toHaveLength(2);
      expect(out[0].content[1]).toEqual({
        type: 'toolCall',
        id: 'toolu_42',
        name: 'Bash',
        arguments: { command: 'ls' },
      });
    }
  });

  it('tool_use with no input → arguments defaults to {}', () => {
    const out = convertOneTowerMessageToPi(assistantMsg([
      { type: 'tool_use', id: 'toolu_43', name: 'Read' /* no input */ },
    ]));
    if (out[0].role === 'assistant') {
      expect((out[0].content[0] as any).arguments).toEqual({});
    }
  });

  it('thinking block (defensive — should be pre-stripped at DB) → dropped', () => {
    const out = convertOneTowerMessageToPi(assistantMsg([
      { type: 'thinking', text: 'internal reasoning' },
      { type: 'text', text: '결론' },
    ]));
    if (out[0].role === 'assistant') {
      expect(out[0].content).toEqual([{ type: 'text', text: '결론' }]);
    }
  });

  it('progress commentary is included in Pi rehydration/model input with commentary phase preserved', () => {
    const out = convertOneTowerMessageToPi(assistantMsg([
      { type: 'commentary', text: 'Worker 서비스를 확인하겠습니다.', phase: 'commentary', visibility: 'progress' },
      { type: 'commentary', text: 'Need internal planning.', phase: 'commentary', visibility: 'hidden' },
      { type: 'tool_use', id: 'toolu_44', name: 'Bash', input: { command: 'npm test' } },
      { type: 'text', text: '완료했습니다.' },
    ]));
    if (out[0].role === 'assistant') {
      expect(out[0].content).toEqual([
        {
          type: 'text',
          text: 'Worker 서비스를 확인하겠습니다.',
          textSignature: JSON.stringify({ v: 1, id: 'a-1_commentary_0', phase: 'commentary' }),
        },
        { type: 'toolCall', id: 'toolu_44', name: 'Bash', arguments: { command: 'npm test' } },
        { type: 'text', text: '완료했습니다.' },
      ]);
    }
  });

  it('assistant row with no surviving content → empty result (caller filters)', () => {
    const out = convertOneTowerMessageToPi(assistantMsg([
      { type: 'thinking', text: 'only thinking' },
    ]));
    expect(out).toEqual([]);
  });

  it('honors custom model / provider / api options', () => {
    const out = convertOneTowerMessageToPi(
      assistantMsg([{ type: 'text', text: 'hi' }]),
      { model: 'openrouter/kimi-k2', provider: 'openrouter', api: 'openai' },
    );
    if (out[0].role === 'assistant') {
      expect(out[0].model).toBe('openrouter/kimi-k2');
      expect(out[0].provider).toBe('openrouter');
      expect(out[0].api).toBe('openai');
    }
  });
});

describe('convertTowerMessagesToPi — sequence integrity', () => {
  it('classic 3-turn (text → assistant w/ tool_use → tool_result → assistant w/ text)', () => {
    const out = convertTowerMessagesToPi([
      userMsg([{ type: 'text', text: '파일 보여줘' }], 'u-1', T0),
      assistantMsg([
        { type: 'text', text: '확인 중' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a.txt' } },
      ], 'a-1', T0 + 1000),
      userMsg([
        { type: 'tool_result', tool_use_id: 'toolu_1', content: '내용입니다' },
      ], 'u-2', T0 + 2000),
      assistantMsg([{ type: 'text', text: '파일 내용은 ...' }], 'a-2', T0 + 3000),
    ]);

    expect(out.map(m => m.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant']);
    // tool_use_id round-trips intact
    if (out[1].role === 'assistant') {
      expect((out[1].content[1] as any).id).toBe('toolu_1');
    }
    if (out[2].role === 'toolResult') {
      expect(out[2].toolCallId).toBe('toolu_1');
    }
  });

  it('empty input → empty output', () => {
    expect(convertTowerMessagesToPi([])).toEqual([]);
  });

  it('long monotonic timestamps stay monotonic in output (no re-ordering)', () => {
    const out = convertTowerMessagesToPi([
      userMsg([{ type: 'text', text: 'first' }], 'u-1', T0),
      assistantMsg([{ type: 'text', text: 'reply 1' }], 'a-1', T0 + 100),
      userMsg([{ type: 'text', text: 'second' }], 'u-2', T0 + 200),
    ]);
    const stamps = out.map(m => m.timestamp);
    for (let i = 1; i < stamps.length; i++) {
      expect(stamps[i]).toBeGreaterThanOrEqual(stamps[i - 1]);
    }
  });

  it('user row with ONLY a tool_result emits exactly one toolResult message (no empty UserMessage)', () => {
    const out = convertTowerMessagesToPi([
      userMsg([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('toolResult');
  });
});
