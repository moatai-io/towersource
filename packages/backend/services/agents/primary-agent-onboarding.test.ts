import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensurePrimaryAgentOnboardingDocument, renderPrimaryAgentOnboardingDocument } from './primary-agent-onboarding.js';

const input = { name: '모아', expectedExpertise: '반복 업무에서 자동화 기회를 찾기' };

describe('Primary Agent first-day onboarding document', () => {
  it('renders a living handoff and working agreement without presuming automation', () => {
    const text = renderPrimaryAgentOnboardingDocument(input);
    expect(text).toContain('시작 맥락');
    expect(text).toContain('생성 시 사용자가 적은 기대');
    expect(text).not.toContain('인재팀');
    expect(text).toContain('업무 계약');
    expect(text).toContain('오늘 바로 같이 해볼 일');
    expect(text).toContain('```mermaid');
    expect(text).toContain('flowchart LR');
    expect(text).toContain('성장 backlog');
    expect(text).toContain('사람 확인 지점');
    expect(text).toContain('TBD');
    expect(text).not.toContain('좋은 후보');
  });

  it('creates once and preserves discoveries on resume', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-primary-onboarding-'));
    ensurePrimaryAgentOnboardingDocument(root, input);
    const target = path.join(root, 'ONBOARDING.md');
    const first = fs.readFileSync(target, 'utf8');
    fs.writeFileSync(target, `${first}\n사용자가 확인한 사실\n`, 'utf8');
    ensurePrimaryAgentOnboardingDocument(root, { ...input, expectedExpertise: '바뀐 문구' });
    expect(fs.readFileSync(target, 'utf8')).toContain('사용자가 확인한 사실');
    expect(fs.readFileSync(target, 'utf8')).not.toContain('바뀐 문구');
    fs.rmSync(root, { recursive: true, force: true });
  });
});
