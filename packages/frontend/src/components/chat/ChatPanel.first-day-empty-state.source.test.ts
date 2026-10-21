import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const chat = fs.readFileSync(path.resolve(import.meta.dirname, 'ChatPanel.tsx'), 'utf-8');
const welcome = fs.readFileSync(path.resolve(import.meta.dirname, '../../features/session-welcome/SessionWelcome.tsx'), 'utf-8');
const ko = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../locales/ko/chat.json'), 'utf-8'));
const en = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../locales/en/chat.json'), 'utf-8'));

describe('ChatPanel empty session welcome wiring', () => {
  it('shows one dialogue welcome for every empty session and connects the real composer', () => {
    expect(chat).toContain('enabled: renderMessages.length === 0 && !isStreaming && !renderSessionLoading');
    expect(chat).toContain('<SessionWelcome project={activeProject} content={welcome.content} isLoading={welcome.isLoading} onInteraction={welcome.onInteraction} onStart={onSend} />');
    expect(chat).toContain('onInteraction={welcome.onInteraction}');
    expect(chat).not.toContain('function EmptyState');
    expect(welcome).toContain('AgentIdentityAvatar');
    expect(welcome).not.toContain('project?.name');
  });
  it('retains localized first-day guide labels and small locale choices', () => {
    for (const locale of [ko, en]) {
      expect(locale.emptyState.startGuide).toBeTruthy();
      expect(locale.welcome.choices).toHaveLength(3);
      expect(locale.welcome.freeInput).toBeTruthy();
    }
    expect(welcome).toContain("start('/tower-intro')");
    expect(welcome).toContain('tower-start-tour');
  });
  it('uses the theme-aware guide token and does not bring back the orbit splash', () => {
    expect(welcome).toContain('text-primary-300');
    expect(welcome).not.toContain('text-primary-200');
    expect(chat).not.toContain('tower-empty-visual');
  });
});
