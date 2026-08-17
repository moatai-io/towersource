import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureProjectAgentInstruction, renderProjectAgentInstruction } from './project-agent-instruction.js';

const original={displayName:'전략 파트너',face:'🧭',tagline:'판단을 선명하게 합니다.',role:'전략 담당자',promise:'결정을 실행으로 이어줍니다.',instruction:'사용자의 판단을 구조화합니다.'};

describe('ensureProjectAgentInstruction',()=>{
  it('materializes one exact block and is idempotent',()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'tower-agent-instruction-'));
    fs.writeFileSync(path.join(root,'AGENTS.md'),'# 테스트\n','utf8');
    ensureProjectAgentInstruction(root,original);
    const once=fs.readFileSync(path.join(root,'AGENTS.md'),'utf8');
    ensureProjectAgentInstruction(root,original);
    const twice=fs.readFileSync(path.join(root,'AGENTS.md'),'utf8');
    expect(twice).toBe(once);
    expect(twice.match(/tower-primary-agent-profile/g)).toHaveLength(2);
    expect(twice).toContain(renderProjectAgentInstruction(original));
    fs.rmSync(root,{recursive:true,force:true});
  });
  it('replaces a stale block without changing surrounding project instructions',()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'tower-agent-instruction-'));
    fs.writeFileSync(path.join(root,'AGENTS.md'),`# 테스트\n\n기존 규칙\n\n${renderProjectAgentInstruction(original)}\n\n마지막 규칙\n`,'utf8');
    ensureProjectAgentInstruction(root,{...original,displayName:'실행 파트너',instruction:'결정을 실행합니다.'});
    const written=fs.readFileSync(path.join(root,'AGENTS.md'),'utf8');
    expect(written).toContain('기존 규칙');expect(written).toContain('마지막 규칙');
    expect(written).toContain('실행 파트너');expect(written).toContain('결정을 실행합니다.');expect(written).not.toContain('전략 파트너');
    fs.rmSync(root,{recursive:true,force:true});
  });
  it('fails closed for missing or malformed AGENTS.md',()=>{
    const missing=fs.mkdtempSync(path.join(os.tmpdir(),'tower-agent-instruction-'));
    expect(()=>ensureProjectAgentInstruction(missing,original)).toThrow('not found');
    fs.writeFileSync(path.join(missing,'AGENTS.md'),'<!-- tower-primary-agent-profile -->\n깨짐','utf8');
    expect(()=>ensureProjectAgentInstruction(missing,original)).toThrow('malformed');
    fs.rmSync(missing,{recursive:true,force:true});
  });
});
