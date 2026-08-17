import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const graphSource = fs.readFileSync(new URL('./WorkspaceKnowledgeGraph.tsx', import.meta.url), 'utf8');
const appSource = fs.readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');

describe('WorkspaceKnowledgeGraph connected document actions', () => {
  it('offers creation for an empty relation graph and upgrade for an existing graph', () => {
    expect(graphSource).toContain("data.summary.edges > 0 ? 'upgrade' : 'create'");
    expect(graphSource).toContain("'연결 문서 업그레이드' : '연결 문서 만들기'");
  });

  it('starts a project-scoped wiki-compile session with an explicit prompt', () => {
    expect(graphSource).toContain("const prompt = `/wiki-compile");
    expect(graphSource).toContain("new CustomEvent('tower-start-prompt-session'");
    expect(graphSource).toContain('projectId,');
    expect(graphSource).toContain("sessionName: creating ? '연결 문서 만들기' : '연결 문서 업그레이드'");
  });

  it('registers the reusable prompt-session event in App', () => {
    expect(appSource).toContain("window.addEventListener('tower-start-prompt-session', handler)");
    expect(appSource).toContain("window.removeEventListener('tower-start-prompt-session', handler)");
  });
});
