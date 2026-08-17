import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
const chat = fs.readFileSync(path.resolve(import.meta.dirname, './ChatPanel.tsx'), 'utf8');

describe('Conversation Primary AI identity', () => {
  it('shows project identity for normal project conversations, not agent backing sessions', () => {
    expect(chat).toContain('!!activeProject && !!activeSession && !isPureAgentSession(activeSession)');
    expect(chat).toContain('assistantProject={showAssistantCharacter ? activeProject : null}');
  });

  it('opens the owning teammate home through the file workspace tab', () => {
    expect(chat).toContain("openSystemTab('projectFiles'");
    expect(chat).toContain('activeProject.agent?.displayName || activeProject.name');
  });

  it('passes resilient identity data into message rendering', () => {
    expect(chat).toContain('onOpenAssistantHome={showAssistantCharacter ? openActiveProjectHome : undefined}');
    expect(chat).toContain('activeProject');
  });
});
