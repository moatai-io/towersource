import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const chat = fs.readFileSync(path.resolve(import.meta.dirname, './ChatPanel.tsx'), 'utf8');
const shared = fs.readFileSync(path.resolve(import.meta.dirname, '../../../../shared/index.ts'), 'utf8');
const sessions = fs.readFileSync(path.resolve(import.meta.dirname, '../../../../backend/services/session/session-manager.ts'), 'utf8');

describe('Primary Agent first-day empty state', () => {
  it('exposes the creation provenance needed to distinguish the first Session', () => {
    expect(shared).toContain('agentCreationCommandId?: string | null');
    expect(sessions).toContain('agentCreationCommandId: creation?.agentCreationCommandId || null');
    expect(sessions).toContain('agentCreationCommandId: row.agent_creation_command_id || null');
  });

  it('shows a Tower-owned start card only for the provisioned first Session', () => {
    expect(chat).toContain('session?.agentCreationCommandId && project');
    expect(chat).toContain("t('emptyState.firstTask')");
    expect(chat).toContain("t('emptyState.firstTaskHint')");
    expect(chat).toContain("t('emptyState.agentStarters', { returnObjects: true })");
  });

  it('sends a selected starter as the user message instead of synthesizing an assistant greeting', () => {
    expect(chat).toContain('onClick={() => onStart(starter)}');
    expect(chat).toContain('<EmptyState session={activeSession} project={activeProject} onStart={onSend} />');
    expect(chat).not.toContain('인재팀에서 제가');
  });

  it('uses the theme-aware primary-300 token for the guide CTA', () => {
    const guideCtaClass = chat.match(/className="([^"]*bg-primary-500\/10[^"]*text-primary-300[^"]*)"/u)?.[1];

    expect(guideCtaClass).toBeDefined();
    expect(guideCtaClass).not.toContain('text-primary-200');
  });
});
