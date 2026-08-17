import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../../packages/frontend/src/index.css';
import { AgentCredentialsModal } from '../../../packages/frontend/src/components/layout/AgentCredentialsModal';
import { DialogProvider } from '../../../packages/frontend/src/hooks/useDialog';

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') === 'light' ? 'light' : 'dark';

const payload = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
window.fetch = async (input) => {
  const url = String(input);
  if (url.includes('/connections/catalog')) return payload({ project: { id: 'agent-fixture', name: '전략 리서치 Agent' }, connections: [
    { id: 'credential:openai-org', source: 'credential', displayName: 'OpenAI 조직 운영 계정', provider: 'openai', connectionType: 'api_key', capabilities: ['text_generation', 'image_generation'], status: 'connected', mode: 'allow', updatedAt: new Date().toISOString() },
    { id: 'profile:gws-default', source: 'profile', displayName: 'Google Workspace 기본 계정', provider: 'google', connectionType: 'oauth', capabilities: ['gmail', 'calendar', 'drive'], status: 'available', mode: null, updatedAt: null },
  ] });
  if (url.endsWith('/projects/agent-fixture/credentials')) return payload({ projectId: 'agent-fixture', credentials: [
    { id: 'custom-research-api-key', provider: 'custom', display_name: '리서치 API 운영 키', kind: 'api_key', default_env_name: 'RESEARCH_API_KEY', scope: 'project', metadata: {}, enabled: true, rotated_at: '2026-08-05T00:00:00Z', updated_at: '2026-08-05T00:00:00Z', mode: 'allow', allowedActions: { reveal: true, inspect: true, replacementAction: 'rotate', reason: 'ordinary_secret' } },
    { id: 'openai-agent-key', provider: 'openai', display_name: 'OpenAI Agent 전용 계정 — 긴 이름 레이아웃 확인', kind: 'api_key', default_env_name: 'OPENAI_AGENT_API_KEY', scope: 'project', metadata: {}, enabled: true, rotated_at: null, updated_at: '2026-08-04T12:00:00Z', mode: 'allow', allowedActions: { reveal: true, inspect: true, replacementAction: 'rotate', reason: 'ordinary_secret' } },
  ] });
  return payload({});
};

const tokenPayload = btoa(JSON.stringify({ role: 'admin', userId: 1 }));
localStorage.setItem('token', `fixture.${tokenPayload}.signature`);

const project = { id: 'agent-fixture', name: '전략 리서치 Agent', agent: { displayName: '전략 리서치 Agent — 한국어와 English Mixed Long Name' } } as any;
function App() { return <DialogProvider><main className="app-bg min-h-screen"><AgentCredentialsModal project={project} onClose={() => undefined} /></main></DialogProvider>; }
createRoot(document.getElementById('root')!).render(<App />);
