import { describe, expect, it } from 'vitest';
import { normalizeMessageSearchText } from './search.js';

describe('workspace search message normalization', () => {
  it('extracts text blocks and omits tool payload inputs', () => {
    const content = JSON.stringify([
      { type: 'text', text: '사용자가 스케줄 검색 개선을 요청했다.' },
      { type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'cat huge-secret-free-payload.json', payload: 'x'.repeat(2000) } },
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'y'.repeat(2000) },
      { type: 'text', text: '최종 답변은 conversation-search 품질 개선이었다.' },
    ]);

    const text = normalizeMessageSearchText(content);

    expect(text).toContain('스케줄 검색 개선');
    expect(text).toContain('conversation-search 품질 개선');
    expect(text).not.toContain('huge-secret-free-payload');
    expect(text).not.toContain('toolu_1');
    expect(text).not.toContain('yyyyyyyyyyyy');
  });

  it('keeps agent_run summaries as searchable human text', () => {
    const content = JSON.stringify([
      { type: 'agent_run', workerName: '검색 리뷰어', summary: 'message snippet에서 tool_use JSON 노출을 줄였다.' },
    ]);

    expect(normalizeMessageSearchText(content)).toBe('검색 리뷰어 message snippet에서 tool_use JSON 노출을 줄였다.');
  });

  it('strips pathological long URLs and blob-like tokens from plain text', () => {
    const longUrl = `https://example.com/${'a'.repeat(600)}`;
    const blob = 'A'.repeat(260);
    const text = normalizeMessageSearchText(`앞부분 ${longUrl} 중간 ${blob} 끝부분`);

    expect(text).toBe('앞부분 중간 끝부분');
  });
});
