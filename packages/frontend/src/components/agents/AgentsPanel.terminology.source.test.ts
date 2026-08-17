import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './AgentsPanel.tsx'), 'utf8');

describe('AgentsPanel helper terminology', () => {
  it('frames project agent definitions as experts', () => {
    expect(source).toContain('>전문가</h2>');
    expect(source).toContain('보조 역할을 설정하고 일을 맡깁니다');
    expect(source).toContain('새 전문가 추가');
    expect(source).toContain('전문가 설정 수정');
  });

  it('keeps technical command details secondary to direct delegation', () => {
    expect(source).toContain('이번에 맡길 일');
    expect(source).toContain('이 조수에게 맡기기');
    expect(source).not.toContain('프로젝트별 subagent 역할을 보고');
  });
});
