import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rail = fs.readFileSync(path.resolve(import.meta.dirname, './AgentNavigationRail.tsx'), 'utf8');
const css = fs.readFileSync(path.resolve(import.meta.dirname, '../../index.css'), 'utf8');

describe('first-level Agent navigation light-theme contrast', () => {
  it('uses the explicit Tower light theme for selected recent and Agent labels even when the OS prefers dark', () => {
    expect(rail).toContain("aria-pressed={scope === 'work' && selectedProjectId === null}");
    expect(rail).toContain("aria-pressed={scope === 'team' && selectedProjectId === null}");
    expect(rail).toContain("aria-current={selected ? 'page' : undefined}");
    expect(css).toContain(':root[data-theme="light"] .agent-nav-rail button[aria-pressed="true"],');
    expect(css).toContain(':root[data-theme="light"] .agent-nav-rail button[aria-current="page"] .fade-overflow-text {\n  color: var(--th-text-primary);');
  });
});
