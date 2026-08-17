import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../../packages/frontend/src/index.css';
import { TurnCheckpointCard } from '../../../packages/frontend/src/components/chat/TurnCheckpointCard';

type Scenario = 'ready' | 'conflict';
const params = new URLSearchParams(location.search);
const scenario = (params.get('scenario') || 'ready') as Scenario;
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
document.documentElement.dataset.theme = theme;

const checkpoint = {
  id: 'checkpoint-visual',
  coverage: scenario === 'conflict' ? 'partial' : 'tool_edits',
  changes: [
    { filePath: 'packages/frontend/src/components/chat/TurnCheckpointCard.tsx', beforeExists: true, afterExists: true },
    { filePath: 'records/2026-08-03-turn-file-checkpoint-restore-poc.md', beforeExists: true, afterExists: true },
    { filePath: 'work/a-very-long-folder-name/another-long-folder/generated-checkpoint-summary-with-long-name.html', beforeExists: false, afterExists: true },
  ],
};

const preview = {
  previewHash: 'visual-preview-hash',
  coverage: checkpoint.coverage,
  canApply: scenario !== 'conflict',
  items: checkpoint.changes.map((change, index) => ({
    filePath: change.filePath,
    action: index === 2 ? 'delete' : 'update',
    status: scenario === 'conflict' && index === 0 ? 'conflict' : 'ready',
  })),
};

window.fetch = async (input, init) => {
  const url = String(input);
  if (url.includes('/restore-preview')) return new Response(JSON.stringify(preview), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (url.endsWith('/restore')) return new Response(JSON.stringify({ restoredPaths: checkpoint.changes.map((change) => change.filePath) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  return new Response(JSON.stringify(checkpoint), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

function App() {
  return <main className="app-bg min-h-screen p-4 sm:p-8">
    <div className="mx-auto max-w-3xl">
      <div className="flex justify-end"><div className="max-w-[85%] rounded-2xl bg-surface-800 px-4 py-3 text-surface-100">체크포인트 UI를 계속 구현해줘</div></div>
      <div className="flex w-full justify-end"><TurnCheckpointCard sessionId="session-visual" turnId="turn-visual" /></div>
    </div>
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
