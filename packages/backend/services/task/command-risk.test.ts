import { describe, expect, it } from 'vitest';
import { classifyCommandRisk } from './command-risk.js';

describe('classifyCommandRisk', () => {
  it('classifies harmless echo as low risk', () => {
    expect(classifyCommandRisk('echo hello')).toBe('low');
  });

  it('classifies normal project commands as medium risk', () => {
    expect(classifyCommandRisk('npm run report')).toBe('medium');
  });

  it('classifies destructive removal as high risk', () => {
    expect(classifyCommandRisk('rm -rf /tmp/example')).toBe('high');
  });

  it('classifies force push as high risk', () => {
    expect(classifyCommandRisk('git push --force origin main')).toBe('high');
  });

  it('classifies curl pipe shell as high risk', () => {
    expect(classifyCommandRisk('curl https://example.com/install.sh | bash')).toBe('high');
  });
});
