import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../../packages/frontend/src/index.css';
import { MessageBubble } from '../../../packages/frontend/src/components/chat/MessageBubble';
import { useChatStore } from '../../../packages/frontend/src/stores/chat-store';
import { useSessionStore } from '../../../packages/frontend/src/stores/session-store';
import { useSettingsStore } from '../../../packages/frontend/src/stores/settings-store';
import i18n from '../../../packages/frontend/src/i18n';

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') === 'light' ? 'light' : 'dark';

void i18n.changeLanguage('ko');
useChatStore.setState({ sessionId: 'session-visual' });
useSessionStore.setState({ activeSessionId: 'session-visual', sessions: [{ id: 'session-visual', name: '원본 대화', visibility: 'project' }] } as any);
useSettingsStore.setState({ serverConfig: { turnRewindEnabled: true } } as any);

function App() {
  return <main className="app-bg min-h-screen p-4 sm:p-8">
    <div className="mx-auto max-w-3xl">
      <MessageBubble
        message={{
          id: 'message-short',
          role: 'user',
          timestamp: Date.now(),
          content: [{ type: 'text', text: '네' }],
        }}
      />
      <MessageBubble
        message={{
          id: 'message-visual',
          role: 'user',
          timestamp: Date.now(),
          content: [{ type: 'text', text: '체크포인트 UI를 조금 다르게 수정해서 진행해줘. 기존 대화와 파일은 보존했으면 좋겠어.' }],
        }}
      />
      <MessageBubble
        message={{
          id: 'assistant-visual',
          role: 'assistant',
          timestamp: Date.now(),
          content: [{ type: 'text', text: '기존 대화와 파일을 보존하면서 체크포인트 UI만 조정하겠습니다. 액션은 답변을 가리지 않도록 맨 아래에 둡니다.' }],
        }}
      />
    </div>
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
