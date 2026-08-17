import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const adminSource = readFileSync(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');
const headerSource = readFileSync(new URL('../layout/Header.tsx', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');

describe('AdminPanel usage integration', () => {
  it('keeps VM-wide usage inside the admin-only panel', () => {
    expect(adminSource).toContain("type AdminTab = 'users' | 'agents' | 'usage' | 'ai' | 'prompts' | 'runtime' | 'credentials' | 'system'");
    expect(adminSource).toContain("renderTab('usage', '사용량')");
    expect(adminSource).toContain("tab === 'usage' && <UsagePanel embedded />");
    expect(adminSource).toContain("const OPERATOR_ALLOWED_TABS: ReadonlySet<AdminTab> = new Set(['users', 'agents', 'runtime', 'credentials'])");
  });

  it('uses the wider admin modal and removes the old global usage entry', () => {
    expect(adminSource).toContain('max-w-[1600px]');
    expect(adminSource).toContain('max-h-[92vh]');
    expect(headerSource).not.toContain('onUsageClick');
    expect(appSource).not.toContain("activeView === 'usage'");
  });
});
