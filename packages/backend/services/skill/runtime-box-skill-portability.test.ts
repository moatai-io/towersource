import fs from 'fs';
import path from 'path';
import os from 'node:os';
import { materializeProjectRegistrySkills } from './project-skill-materializer.js';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RUNTIME_BOX_MATERIALIZED_SKILLS } from '../../config.js';
import { auditRuntimeBoxSkillBody } from './runtime-box-skill-portability.js';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');

function managedSkillBody(name: string): string {
  return fs.readFileSync(path.join(repoRoot, 'skills', 'managed', name, 'SKILL.md'), 'utf8');
}

describe('Runtime Box managed skill portability', () => {
  it('audits every shipped default skill without requiring optional managed catalog bodies', () => {
    const failures = DEFAULT_RUNTIME_BOX_MATERIALIZED_SKILLS.flatMap(name => {
      const skillPath = path.join(repoRoot, 'skills', 'managed', name, 'SKILL.md');
      // Defaults are optional: seedProjectDefaultSkills records unavailable bundles as degraded.
      if (!fs.existsSync(skillPath)) return [];
      return auditRuntimeBoxSkillBody(managedSkillBody(name)).map(issue => ({ name, code: issue.code }));
    });
    expect(failures).toEqual([]);
  });

  it('records unavailable optional catalog defaults without admitting them to the runtime manifest', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-skill-portability-'));
    try {
      const result = materializeProjectRegistrySkills({ projectRootPath: root, skillNames: ['fixture-unavailable-catalog-skill'], storageMode: 'copy' });
      expect(result.materialized).toEqual([]);
      expect(result.ok).toBe(false);
      expect(result.skipped.map(({ name, reason }) => ({ name, reason }))).toEqual(['fixture-unavailable-catalog-skill'].map(name => ({ name, reason: 'not_found_or_disallowed' })));
      expect(JSON.parse(fs.readFileSync(result.manifestPath, 'utf8')).skills).toEqual([]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
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
