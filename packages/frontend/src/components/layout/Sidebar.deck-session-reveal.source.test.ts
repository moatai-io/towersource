import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const sidebar = fs.readFileSync(path.resolve(__dirname, 'Sidebar.tsx'), 'utf8');
const sessionLifecycle = fs.readFileSync(path.resolve(__dirname, '../../hooks/useSessionLifecycle.ts'), 'utf8');

describe('Deck session reveal', () => {
  it('requests a sidebar reveal after a new session is created without changing sort metadata', () => {
    expect(sessionLifecycle).toContain("new CustomEvent('tower-reveal-session-in-sidebar'");
    expect(sessionLifecycle).toContain('sessionId: session.id');
    expect(sessionLifecycle).toContain("label: session.label ?? label ?? null, origin: 'created'");
  });

  it('reveals only in Deck view, expands the target Deck, and scrolls the rendered row', () => {
    expect(sidebar).toContain('if (!filterLabels) return;');
    expect(sidebar).toContain("detail.label || '__uncategorized__'");
    expect(sidebar).toContain('projectStore.toggleLabelCollapsed');
    expect(sidebar).toContain('data-sidebar-session-id');
    expect(sidebar).toContain("row.scrollIntoView({ block: 'nearest', behavior: 'smooth' })");
  });
});
