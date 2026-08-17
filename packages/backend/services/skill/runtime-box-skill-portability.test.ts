import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RUNTIME_BOX_MATERIALIZED_SKILLS } from '../../config.js';
import { auditRuntimeBoxSkillBody } from './runtime-box-skill-portability.js';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');

function managedSkillBody(name: string): string {
  return fs.readFileSync(path.join(repoRoot, 'skills', 'managed', name, 'SKILL.md'), 'utf8');
}

describe('Runtime Box managed skill portability', () => {
  it('keeps every default materialized skill free of host-only execution assumptions', () => {
    const failures = DEFAULT_RUNTIME_BOX_MATERIALIZED_SKILLS.flatMap(name => {
      const skillPath = path.join(repoRoot, 'skills', 'managed', name, 'SKILL.md');
      if (!fs.existsSync(skillPath)) return [{ name, code: 'missing-managed-skill' }];
      return auditRuntimeBoxSkillBody(managedSkillBody(name)).map(issue => ({ name, code: issue.code }));
    });
    expect(failures).toEqual([]);
  });

  it('detects representative host paths, local APIs, and control-plane commands', () => {
    const issues = auditRuntimeBoxSkillBody(`
\`\`\`bash
python3 ~/.claude/skills/wip/scripts/dashboard.py
curl http://localhost:32364/api/search
pm2 status
RESPONSE_FILE=/tmp/codex-response-123.md
\`\`\`
    `);
    expect(issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'host_skill_path', 'host_local_api', 'host_control_plane_cli', 'host_tmp_handoff',
    ]));
  });
});
