import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const projectSkill = fs.readFileSync(path.join(process.cwd(), 'skills/project-credentials/SKILL.md'), 'utf8');
const compatibilitySkill = fs.readFileSync(path.join(process.cwd(), 'skills/runtime-box-credentials/SKILL.md'), 'utf8');

describe('Project credential skill routing', () => {
  it('uses project-credentials as the execution-plane-neutral entrypoint', () => {
    expect(projectSkill).toContain('name: project-credentials');
    expect(projectSkill).toContain('canonical-project-workspace');
    expect(projectSkill).toContain('legacy-worker-workspace');
    expect(projectSkill).toContain('resolveProjectExecutionContext');
    expect(projectSkill).toContain('Runtime Box compatibility');
    expect(projectSkill).toContain('resolveRemoteWorkbenchCredentialEnv');
    expect(projectSkill).toContain('Project `bash`');
    expect(projectSkill).not.toMatch(/Project Runtime Box(?:에서| 안에서)[^\n]{0,80}(?:우선|실행)/);
  });

  it('keeps runtime-box-credentials bounded to compatibility Projects', () => {
    expect(compatibilitySkill).toContain('Compatibility Diagnostics');
    expect(compatibilitySkill).toContain('중단하고 `/project-credentials` 사용');
    expect(compatibilitySkill).toContain('Runtime Box compatibility가 명시적으로 확인된 legacy Project만');
    expect(compatibilitySkill).toContain('Runtime Box가 없는 canonical 또는 legacy Worker workspace Project에 box를 새로 만들지 않는다');
  });

  it('forbids secret values and legacy-shell workarounds in both skills', () => {
    for (const source of [projectSkill, compatibilitySkill]) {
      expect(source).toMatch(/Secret 값|Secret value|Secret 값,/i);
      expect(source).toContain('present-redacted');
      expect(source).not.toMatch(/cat\s+[^\n]*\.env/);
    }
    expect(projectSkill).toContain('project_shell_legacy');
    expect(compatibilitySkill).toContain('project_shell_legacy');
  });
});
