import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../../packages/frontend/src/index.css';
import { StatusLine } from '../../../packages/frontend/src/components/chat/StatusLine';
import { useChatStore } from '../../../packages/frontend/src/stores/chat-store';
import i18n from '../../../packages/frontend/src/i18n';
const snapshot = { windowTokens: 200_000, capturedAt: '2026-01-01T00:00:00Z', pressure: {
  tokens: 144_000, thresholdTokens: 144_000, policy: 'tower-pre-prompt', source: 'projection', observedAt: 1 } };
const restored = new URLSearchParams(location.search).has('restored');
useChatStore.setState({ cost: { ...useChatStore.getState().cost, contextInputTokens: restored ? 0 : 100_000,
  contextWindowSize: restored ? 0 : 200_000, contextSnapshot: restored ? undefined : snapshot },
  messages: restored ? [{ id: 'restored', role: 'assistant', content: [], timestamp: 1,
    metadata: { usage: { context_input_tokens: 100_000, context_window_size: 200_000, context_snapshot: snapshot } } }] : [] });
void i18n.changeLanguage('ko').then(() => createRoot(document.getElementById('root')!).render(<main><StatusLine /></main>));
