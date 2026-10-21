import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '@tower/shared';
import { AgentSessionBadge } from './AgentSessionBadge';

function render(overrides: Record<string, unknown>) {
  const session = { id: 'fixture', name: 'Session', ...overrides } as unknown as SessionMeta;
  return renderToStaticMarkup(<AgentSessionBadge session={session} />);
}

describe('Agent session identity badge', () => {
  it.each([
    { label: 'agent' },
    { agent: { workerId: 'worker-fixture' } },
    { label: 'task', agent: { workerId: 'worker-fixture' } },
    { label: 'agent', userTurnCount: 7, turnCount: 12 },
  ])('renders the compact badge for persisted identity: %j', (fixture) => {
    const html = render(fixture);
    expect(html).toMatch(/>agent<\/span>/);
    expect(html).toContain('tone-pill tone-warning');
  });

  it.each([{}, { label: 'task' }, { name: 'agent helper' }, { userTurnCount: 7 }])(
    'does not infer worker identity from a name or conversation: %j',
    (fixture) => expect(render(fixture)).toBe(''),
  );
});
