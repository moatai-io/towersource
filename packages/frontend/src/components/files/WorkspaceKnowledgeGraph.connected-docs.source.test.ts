import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const graphSource = fs.readFileSync(new URL('./WorkspaceKnowledgeGraph.tsx', import.meta.url), 'utf8');
const appSource = fs.readFileSync(new URL('../../hooks/useMessageExecution.ts', import.meta.url), 'utf8');

describe('WorkspaceKnowledgeGraph connected document actions', () => {
  it('offers creation for an empty relation graph and upgrade for an existing graph', () => {
    expect(graphSource).toContain("data.summary.edges > 0 ? 'upgrade' : 'create'");
    expect(graphSource).toContain("t('knowledgeGraph.upgradeConnectedDocs'):t('knowledgeGraph.createConnectedDocs')");
  });

  it('starts a project-scoped wiki-compile session with an explicit prompt', () => {
    expect(graphSource).toContain("const prompt = `/wiki-compile");
    expect(graphSource).toContain("new CustomEvent('tower-start-prompt-session'");
    expect(graphSource).toContain('projectId,');
    expect(graphSource).toContain("sessionName: creating ? t('knowledgeGraph.createConnectedDocs') : t('knowledgeGraph.upgradeConnectedDocs')");
  });

  it('registers the reusable prompt-session event in App', () => {
    expect(appSource).toContain("window.addEventListener('tower-start-prompt-session', handler)");
    expect(appSource).toContain("window.removeEventListener('tower-start-prompt-session', handler)");
  });
});
