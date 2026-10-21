import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const panel = fs.readFileSync(path.resolve('packages/frontend/src/components/chat/ChatPanel.tsx'), 'utf8');
const item = fs.readFileSync(path.resolve('packages/frontend/src/components/sessions/SessionItem.tsx'), 'utf8');
const tabs = fs.readFileSync(path.resolve('packages/frontend/src/components/layout/FileTabBar.tsx'), 'utf8');

describe('server-backed AI response unread UI', () => {
  it('marks read after an assistant response is rendered in the visible chat', () => {
    expect(panel).toContain("activeSession?.unreadAiResponse");
    expect(panel).toContain('visibleChatSessionId !== activeSessionId');
    expect(panel).toContain("document.visibilityState !== 'visible'");
    expect(panel).toContain("messages.some((message) => message.role === 'assistant')");
    expect(panel).toContain('markAiResponseRead(activeSessionId, sequence)');
  });

  it('does not let unreliable mobile document focus block read acknowledgement', () => {
    expect(panel).toContain('const isMobile = useSessionStore((s) => s.isMobile)');
    expect(panel).toContain("if (!isMobile && typeof document.hasFocus === 'function' && !document.hasFocus()) return;");
  });

  it('uses server unread state for rows and tabs without clearing it on selection', () => {
    expect(item).toContain('session.unreadAiResponse === true');
    expect(item).not.toContain('markSessionRead(session.id)');
    expect(tabs).toContain('session?.unreadAiResponse === true');
    expect(tabs).not.toContain('markSessionRead(sessionId)');
  });

  it('offers subscription control in the existing Session context menu', () => {
    expect(item).toContain('setSessionSubscription(session.id, subscribed)');
    expect(item).toContain('stopNewAnswerNotifications');
    expect(item).toContain('receiveNewAnswers');
  });
});
