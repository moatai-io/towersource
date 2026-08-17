import React from 'react';
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import { AgentGoogleConnectionSetup, type AgentGoogleSetup } from '../src/components/files/AgentGoogleConnectionSetup';

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') === 'light' ? 'light' : 'dark';

const connections = [
  { id: 'gws-organization-primary', displayName: '조직 Google Workspace · juliuschun@doomoolmori.com', googleAccount: 'juliuschun@doomoolmori.com' },
  { id: 'gws-organization-publishing', displayName: '조직 Google Workspace · publishing@example.com', googleAccount: 'publishing@example.com' },
];

function App() {
  const [value, setValue] = React.useState<AgentGoogleSetup>({ mode: 'organization', credentialId: connections[0].id });
  return <main className="app-bg min-h-screen p-4 sm:p-10"><div className="mx-auto max-w-2xl"><AgentGoogleConnectionSetup value={value} onChange={setValue} connections={connections} loading={false} /></div></main>;
}
createRoot(document.getElementById('root')!).render(<App />);
