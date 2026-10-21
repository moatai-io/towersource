import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const hub = fs.readFileSync(path.resolve(import.meta.dirname, './WorkHub.tsx'), 'utf8');
const inbox = fs.readFileSync(path.resolve(import.meta.dirname, '../inbox/InboxPanel.tsx'), 'utf8');
const app = fs.readFileSync(path.resolve(import.meta.dirname, '../../App.tsx'), 'utf8');

describe('Session-centered Work hub', () => {
  it('combines compact new results with the existing workstream timeline', () => {
    expect(hub).toContain('<InboxPanel variant="work-results"');
    expect(hub).toContain('<ChallengeTimelinePanel embedded />');
    expect(hub).toContain('data-testid="work-hub"');
    expect(hub).toContain("t('workHub.title')");
    expect(hub).toContain('overflow-y-auto overscroll-y-contain');
    expect(hub).toContain('@min-[64rem]/work:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]');
  });

  it('shows unread Session results as semantic opening lines linked to the source conversation', () => {
    expect(inbox).toContain("variant?: 'full' | 'work-results'");
    expect(inbox).toContain("variant === 'work-results'");
    expect(inbox).toContain('extractSemanticLead(message.content)');
    expect(inbox).toContain('onClick={() => openSession(session)}');
    expect(inbox).toContain('resultCards = allCards.filter(({ isUnread }) => isUnread)');
    expect(inbox).toContain('roomStore.markNotificationRead(notification.id)');
    expect(inbox).toContain("notification.metadata?.sessionId || notification.sessionId");
  });

  it('routes both desktop and mobile Work surfaces through the combined hub', () => {
    expect(app.match(/<WorkHub onSelectSession=\{handleSelectSession\} \/>/g)).toHaveLength(2);
    expect(app).not.toContain('<ChallengeTimelinePanel />');
  });
});
