import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../../packages/frontend/src/index.css';
import '../../../packages/frontend/src/i18n';
import { InputBox } from '../../../packages/frontend/src/components/chat/InputBox';
import { useChatStore } from '../../../packages/frontend/src/stores/chat-store';
import { useSessionStore } from '../../../packages/frontend/src/stores/session-store';
import i18n from '../../../packages/frontend/src/i18n';
void i18n.changeLanguage('ko');
document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') || 'dark';
useChatStore.setState({ sessionId: 'floating-fixture', messages: [{ id: 'reply', role: 'assistant', content: [{ type: 'text', text: '답변' }], timestamp: Date.now() }] });
useSessionStore.setState({ activeSessionId: 'floating-fixture', streamingSessions: new Set() });
const steering = new URLSearchParams(location.search).has('steering');
if (steering) {
  useChatStore.setState({ isStreaming: true, pendingInjections: { 'floating-fixture': [{ id: 'pending', text: '방금 보낸 질문' }] } });
  useSessionStore.setState({ streamingSessions: new Set(['floating-fixture']) });
}
createRoot(document.getElementById('root')!).render(
  <main className="app-bg flex h-dvh flex-col overflow-hidden text-surface-200">
    <section data-testid="transcript" className="min-h-0 flex-1 overflow-y-auto px-6">
      {Array.from({ length: 60 }, (_, i) => <p key={i} className="py-2">본문 {i + 1} — 버튼 옆에서도 읽고 선택할 수 있는 채팅입니다.</p>)}
    </section>
    <div className="shrink-0 px-4 pb-2"><InputBox activeTurnStatus={steering ? <span data-testid="fixture-running">도구 실행 중</span> : null} onSend={() => {}} onAbort={() => {}} /></div>
  </main>
);
