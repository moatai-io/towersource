import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { classifyAgentsMd, reconcileProjectAgentsMd } from './reconcile-default-agents-md.js';

const legacy = `# Example

설명

## First Contact
## Early Project Formation
## Working Rhythm
## Records
## Knowledge Updates
자세한 배경, 긴 요약, 여러 자료의 종합은 \`.wiki/\`에 점진적으로 컴파일한다.
## Long-Term Interaction

4. 행동 규칙으로 굳어진 것만 \`AGENTS.md\`에 짧게 반영한다.
`;

describe('reconcile-default-agents-md', () => {
  it('classifies only the known legacy template as replaceable', () => {
    expect(classifyAgentsMd(undefined)).toBe('missing');
    expect(classifyAgentsMd('<!-- tower-default-agents-template:v2 -->')).toBe('current');
    expect(classifyAgentsMd(legacy)).toBe('legacy-default');
    expect(classifyAgentsMd(`${legacy}\n사용자 고유 규칙`)).toBe('customized');
    expect(classifyAgentsMd('# Custom\n\n사용자 규칙')).toBe('customized');
  });

  it('dry-runs and applies a legacy replacement with a backup', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-agents-reconcile-'));
    try {
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), legacy, 'utf8');
      expect(reconcileProjectAgentsMd(dir, false).action).toBe('would-replace');
      expect(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toBe(legacy);
      expect(reconcileProjectAgentsMd(dir, true).action).toBe('replaced');
      const next = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
      expect(next).toContain('<!-- tower-default-agents-template:v2 -->');
      expect(next).toContain('유능한 비서이자 업무 파트너');
      expect(fs.readFileSync(path.join(dir, 'AGENTS.md.bak-before-default-v2'), 'utf8')).toBe(legacy);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('preserves customized files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-agents-reconcile-'));
    try {
      const custom = '# Custom\n\n고객이 작성한 규칙\n';
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), custom, 'utf8');
      expect(reconcileProjectAgentsMd(dir, true).action).toBe('skipped');
      expect(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toBe(custom);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
