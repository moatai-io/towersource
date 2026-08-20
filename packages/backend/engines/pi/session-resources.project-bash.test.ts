import { describe, expect, it } from 'vitest';
import { normalizeProjectBashPrompt } from './session-resources.js';

describe('Project bash prompt normalization', () => {
  it('removes retired shell-selection wording and appends the authority-routed bash contract', () => {
    const normalized = normalizeProjectBashPrompt([
      'keep this policy',
      '- In project Runtime Box sessions, use project-mounted skills.',
      '- Inside `project_shell`, inspect the manifest.',
      '- Host `bash` intentionally does not receive Project Credential Vault values.',
      '- A host-bash `missing` result is not evidence.',
      '- Provider checks must run through `project_shell`.',
    ].join('\n'));
    expect(normalized).toContain('keep this policy');
    expect(normalized).not.toContain('project_shell');
    expect(normalized).not.toContain('Runtime Box sessions');
    expect(normalized).not.toContain('host-bash `missing`');
    expect(normalized).toContain('Use `bash` as the native shell of this Project Workstation');
    expect(normalized).toContain('Commands start in the current Project directory');
    expect(normalized).toContain('Missing software is not a permanent platform restriction');
    expect(normalized).toContain('Never switch to another execution plane automatically');
  });
});
