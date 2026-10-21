import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');
const header = readFileSync(new URL('../../components/layout/Header.tsx', import.meta.url), 'utf8');
const events = readFileSync(new URL('../../hooks/useSessionEventNavigation.ts', import.meta.url), 'utf8');

describe('secretariat app integration', () => {
  it('exposes a discoverable entry in the existing personal menu and closes conflicting surfaces', () => {
    expect(header).toContain('data-testid={testId}');
    expect(header).toContain('testId="global-nav-secretariat"');
    expect(header).toContain("label={t('secretariat')}");
    expect(app).toContain('onSecretariatClick={() => setSecretariatOpen(true)}');
  });

  it('mounts the same account-keyed surface in desktop and mobile routers', () => {
    expect(app.match(/secretariat=\{<SecretariatPanel key=\{token \?\? 'anonymous'\} \/>\}/g)).toHaveLength(2);
  });

  it('reuses the actual application session event handler', () => {
    expect(events).toContain("window.addEventListener('kanban-select-session', handleNavigation)");
  });
});

it('preserves desktop sidebar when opening secretariat', () => {
  const app = readFileSync('packages/frontend/src/App.tsx', 'utf8');
  const handler = app.slice(app.indexOf('onSecretariatClick={() =>'), app.indexOf('onSessionFileClick='));
  expect(handler).not.toContain('setActiveView'); expect(handler).not.toContain('setSidebarOpen');
});

it('recent session entry opens the same dialog without replacing the workspace',()=>{
 const selection=readFileSync('packages/frontend/src/hooks/useSessionSelection.ts','utf8');
 expect(selection).toContain("session.label === 'personal_secretary'");
 expect(selection).toContain("new CustomEvent('secretariat-open')");
 const app=readFileSync('packages/frontend/src/App.tsx','utf8');
 expect(app).toContain("window.addEventListener('secretariat-open', open)");
});
