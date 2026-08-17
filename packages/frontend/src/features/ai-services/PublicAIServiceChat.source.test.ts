import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './PublicAIServiceChat.tsx'), 'utf8');
const main = fs.readFileSync(path.resolve(import.meta.dirname, '../../main.tsx'), 'utf8');

describe('Public AI Service hosted chat page source contract', () => {
  it('mounts the stable website route outside the authenticated App shell', () => {
    expect(main).toContain("import('./features/ai-services/PublicAIServiceChat')");
    expect(main).toContain('path="/ai/:channelId"');
    expect(main).toContain('path="/ai-service-chat/:channelId"');
    expect(main.indexOf('path="/ai/:channelId"')).toBeLessThan(main.indexOf('path="*"'));
  });

  it('supports optional advanced Channel credentials from URL hash without requiring them', () => {
    expect(source).toContain('tokenFromHash');
    expect(source).toContain('window.location.hash');
    expect(source).toContain("params.get('token')");
    expect(source).toContain("const base = token ? 'channels' : 'sites'");
    expect(source).not.toContain('window.location.search');
  });

  it('calls public website APIs by default and credential APIs only when a token exists', () => {
    expect(source).toContain('/api/ai-service-public/${base}/');
    expect(source).toContain('...(token ? { Authorization: `Bearer ${token}` } : {})');
    expect(source).toContain('/conversations/${encodeURIComponent(activeConversation.id)}/messages');
    expect(source).toContain('{ accessPassword }');
    expect(source).toContain('{ message: text, accessPassword }');
  });

  it('persists public resume grants across browser restarts and restores only server-verified history', () => {
    expect(source).toContain('resumeToken?: string');
    expect(source).toContain('const storage = token ? window.sessionStorage : window.localStorage');
    expect(source).toContain('/conversations/${encodeURIComponent(stored.id)}/resume');
    expect(source).toContain('{ resumeToken: stored.resumeToken, accessPassword }');
    expect(source).toContain('restoredMessagesFromResponse(data)');
    expect(source).toContain('setMessages(restoredMessages)');
    expect(source).toContain('isInvalidResumeCredential');
  });

  it('waits for explicit password entry before resuming and preserves stored state on wrong passwords', () => {
    expect(source).toContain("if (token || !stored?.resumeToken || metadata?.access?.mode === 'password') return");
    expect(source).not.toContain("[accessPassword, channelId, metadata?.access?.mode, token]");
    expect(source).toContain('const stored = storedConversation(channelId, token)');
    expect(source).toContain('{ resumeToken: stored.resumeToken, accessPassword }');
    expect(source).toContain('if (!isInvalidResumeCredential(resumeError)) throw resumeError');
    expect(source).toContain('await createConversation()');
  });

  it('renders a Tower-like chat shell without importing the private ChatPanel', () => {
    expect(source).toContain("import { RichContent } from '../../components/shared/RichContent'");
    expect(source).toContain('<RichContent text={message.text} colorMode={theme} />');
    expect(source).toContain('function AgentFaceMark');
    expect(source).toContain('AgentCharacterAvatar');
    expect(source).toContain('agentFaceImageUrl');
    expect(source).toContain('function MessageBubble');
    expect(source).toContain('h-[var(--public-chat-viewport-height,100dvh)]');
    expect(source).toContain('max-h-[var(--public-chat-viewport-height,100dvh)]');
    expect(source).toContain('배포된 AI 에이전트');
    expect(source).toContain('Tower AI Service');
    expect(source).toContain('agentFace={agentFace}');
    expect(source).toContain('응답을 작성하는 중');
    expect(source).toContain('AI가 실수할 수 있습니다');
    expect(source).toContain('<textarea');
    expect(source).toContain("event.key === 'Enter' && !event.shiftKey");
    expect(source).toContain('고급 credential 링크로 접속했습니다');
    expect(source).not.toContain('ChatPanel');
  });

  it('keeps the composer available while a response is running and queues later turns locally', () => {
    expect(source).toContain('queuedMessages');
    expect(source).toContain('setQueuedMessages((current) => [...current');
    expect(source).toContain('다음 턴 대기열');
    expect(source).toContain('응답 중에도 입력할 수 있어요');
    expect(source).not.toContain('<textarea ref={inputRef} value={input} disabled={busy}');
  });

  it('guards Korean IME composition and does not repeat a final syllable as a second message', () => {
    expect(source).toContain('!event.nativeEvent.isComposing');
    expect(source).toContain('event.nativeEvent.keyCode !== 229');
    expect(source).not.toContain('>나</div>');
  });

  it('pins readable light-theme prose colors and synchronizes the document theme contract', () => {
    expect(source).toContain('publicThemeVariables');
    expect(source).toContain("'--th-prose-body': '#1f2937'");
    expect(source).toContain('style={publicThemeVariables}');
    expect(source).toContain("document.documentElement.setAttribute('data-theme', theme)");
    expect(source).toContain("document.documentElement.classList.toggle('dark', theme === 'dark')");
    expect(source).toContain('document.documentElement.style.colorScheme = theme');
  });

  it('uploads TXT/CSV files into the current Conversation and restores their list', () => {
    expect(source).toContain('type ConversationFile');
    expect(source).toContain('uploadConversationFile');
    expect(source).toContain("form.append('file', file)");
    expect(source).toContain("form.append('resumeToken', activeConversation.resumeToken)");
    expect(source).toContain("new URLSearchParams({ resumeToken: activeConversation.resumeToken");
    expect(source).toContain('/conversations/${encodeURIComponent(activeConversation.id)}/files`');
    expect(source).toContain('loadConversationFiles(stored)');
    expect(source).toContain('accept=".txt,.csv,text/plain,text/csv"');
    expect(source).toContain('이 대화에 자료 첨부');
    expect(source).toContain('removeConversationFile');
  });

  it('pins the composer inside the mobile visual viewport and respects the bottom safe area', () => {
    expect(source).toContain('window.visualViewport');
    expect(source).toContain("root.style.setProperty('--public-chat-viewport-height'");
    expect(source).toContain("viewport?.addEventListener('resize', syncViewportHeight)");
    expect(source).toContain("viewport?.addEventListener('scroll', syncViewportHeight)");
    expect(source).toContain('overflow-hidden');
    expect(source).toContain('pb-[max(0.75rem,env(safe-area-inset-bottom))]');
    expect(source).toContain('data-public-chat-composer');
  });

  it('uses fixed-size mobile header actions instead of breaking Korean labels vertically', () => {
    expect(source).toContain('flex shrink-0 items-center gap-1 sm:gap-1.5');
    expect(source).toContain('h-9 w-9 shrink-0 items-center justify-center');
    expect(source).toContain('aria-label="이 AI에 대해"');
    expect(source).toContain('<span aria-hidden="true" className="sm:hidden">ⓘ</span>');
    expect(source).toContain("<span aria-hidden=\"true\" className=\"sm:hidden\">{light ? '☾' : '☀'}</span>");
    expect(source).toContain('<span className="hidden sm:inline">이 AI에 대해</span>');
    expect(source).toContain('hidden truncate text-[11px] sm:block');
    expect(source).toContain('min-w-0 flex-1 overflow-hidden');
  });

  it('streams public responses progressively and exposes an abort control', () => {
    expect(source).toContain('/stream`');
    expect(source).toContain('response.body.getReader()');
    expect(source).toContain('new TextDecoder()');
    expect(source).toContain("event.type === 'text'");
    expect(source).toContain('requestAbortRef.current?.abort()');
    expect(source).toContain('aria-label="응답 중지"');
  });

  it('respects manual reading position and offers an explicit jump to new messages', () => {
    expect(source).toContain('isNearBottomRef');
    expect(source).toContain('handleConversationScroll');
    expect(source).toContain('showJumpToLatest');
    expect(source).toContain('새 메시지 ↓');
    expect(source).not.toContain('[messages, busy, elapsedNow]');
  });

  it('auto-grows the composer without breaking Korean IME behavior', () => {
    expect(source).toContain('useLayoutEffect');
    expect(source).toContain("node.style.height = 'auto'");
    expect(source).toContain('Math.min(node.scrollHeight, 160)');
    expect(source).toContain('ref={inputRef}');
  });

  it('shows a useful empty state and one retry surface for failed responses', () => {
    expect(source).toContain('suggestions.map');
    expect(source).toContain('에게 물어보세요');
    expect(source).toContain('retryFailed');
    expect(source).toContain('다시 시도');
    expect(source).not.toContain('요청을 처리하지 못했습니다: ${message}');
  });

  it('does not render an empty assistant bubble before the first streamed text arrives', () => {
    expect(source).not.toContain("setMessages((current) => [...current, { role: 'assistant', text: '' }])");
    expect(source).toContain("if (last?.role === 'assistant')");
    expect(source).toContain("return [...current, { role: 'assistant', text: event.text! }]");
    expect(source).toContain("messages[messages.length - 1]?.role !== 'assistant'");
  });

  it('streams public responses progressively and lets the user stop generation', () => {
    expect(source).toContain('/stream`');
    expect(source).toContain('response.body.getReader()');
    expect(source).toContain('new TextDecoder()');
    expect(source).toContain("event.type === 'text'");
    expect(source).toContain('requestAbortRef.current?.abort()');
    expect(source).toContain('응답 중지');
    expect(source).toContain('isLive={busy && index === messages.length - 1');
  });

  it('exposes public-safe UI transparency controls for theme, timing, tools, and materials', () => {
    expect(source).toContain("type ThemeMode = 'light' | 'dark'");
    expect(source).toContain('prefers-color-scheme: light');
    expect(source).toContain('setTheme(light ? \'dark\' : \'light\')');
    expect(source).toContain('/api/ai-service-public/sites/${encodeURIComponent(channelId)}/metadata');
    expect(source).toContain('할 수 있는 일');
    expect(source).toContain('공개된 자료');
    expect(source).toContain('formatElapsed(elapsedNow)');
    expect(source).toContain('toolsFromResponse(response)');
    expect(source).toContain('원본 Project 폴더에는 접근하지 않습니다');
  });

  it('honors public UI visibility flags from Channel metadata', () => {
    expect(source).toContain('showInfoPanel');
    expect(source).toContain('showInfoDrawer');
    expect(source).toContain('이 AI에 대해');
    expect(source).toContain('role="dialog"');
    expect(source).toContain('showTools');
    expect(source).toContain('showMaterials');
    expect(source).toContain('showTiming');
    expect(source).not.toContain("lg:grid-cols-[minmax(0,1fr)_320px]");
    expect(source).toContain('showTiming && message.elapsedMs');
    expect(source).toContain('showTools && message.tools');
  });

  it('renders public-safe access gates for password, login-required, and disabled modes', () => {
    expect(source).toContain('accessMode');
    expect(source).toContain('accessBlocked');
    expect(source).toContain('비밀번호가 필요한 AI 웹사이트입니다');
    expect(source).toContain('unlockPassword');
    expect(source).toContain('로그인이 필요합니다');
    expect(source).toContain('외부 접근을 중지했습니다');
  });

  it('offers explicit new-conversation control after restoring browser continuity', () => {
    expect(source).toContain('startNewConversation');
    expect(source).toContain('이 브라우저의 이전 대화를 이어서 열었습니다.');
    expect(source).toContain('새 대화 시작');
    expect(source).toContain('removeItem(conversationStorageKey(channelId, token))');
  });

  it('renders deployment-defined customer request CTAs with explicit confirmation', () => {
    expect(source).toContain('requestActions?: RequestAction[]');
    expect(source).toContain('submitCustomerRequest');
    expect(source).toContain('/requests`');
    expect(source).toContain('idempotencyKey');
    expect(source).toContain('담당자에게 전달할 내용을 확인해 주세요');
    expect(source).toContain('requestAction.confirmationLabel');
  });

  it('renders customer-readable answer provenance and actions instead of raw tool labels', () => {
    expect(source).toContain('friendlyToolName');
    expect(source).toContain("knowledge_search: '선택된 자료 검색'");
    expect(source).toContain('citationsFromResponse');
    expect(source).toContain('이 답변의 근거');
    expect(source).toContain('답변 복사');
    expect(source).toContain('도움됨');
    expect(source).toContain('아쉬움');
    expect(source).not.toContain('<span>사용 도구</span>');
  });

  it('shows public metadata, tools, materials, elapsed time, and light/dark mode', () => {
    expect(source).toContain('/metadata');
    expect(source).toContain("method = 'POST'");
    expect(source).toContain("undefined, 'GET'");
    expect(source).toContain('type ThemeMode');
    expect(source).toContain('ai-service-chat-theme');
    expect(source).toContain('formatElapsed(message.elapsedMs)');
    expect(source).toContain('friendlyToolName');
    expect(source).toContain('할 수 있는 일');
    expect(source).toContain('공개된 자료');
    expect(source).toContain('setInterval');
    expect(source).toContain("{light ? '어둡게' : '밝게'}");
  });
});
