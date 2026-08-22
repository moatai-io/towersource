import React from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import i18n from '../../i18n';
import { RichContent } from '../../components/shared/RichContent';
import { AgentCharacterAvatar, agentFaceImageUrl, characterFace } from '../agent-profile/characters';

type ToolSummary = { name: string; input?: Record<string, unknown> };
type CitationSummary = { title: string; path: string; citedLineStart: number; citedLineEnd: number; label?: string };
type ChatMessage = { role: 'user' | 'assistant' | 'system'; text: string; elapsedMs?: number; tools?: ToolSummary[]; citations?: CitationSummary[] };
type ThemeMode = 'light' | 'dark';
type RequestAction = { id: string; label: string; description?: string; confirmationLabel: string; fields: Array<'name' | 'email' | 'phone'> };
type ConversationFile = { id: string; name: string; mimeType: string; sizeBytes: number; status: string; createdAt: string };

type ConversationState = {
  id: string;
  deploymentId?: string;
  resumeToken?: string;
  resumeExpiresAt?: string;
};

type QueuedMessage = { id: string; text: string; status?: string };

type SiteMetadata = {
  name?: string;
  face?: string;
  description?: string;
  channelName?: string;
  access?: { mode?: 'public' | 'unlisted' | 'password' | 'login_required' | 'disabled'; hasPassword?: boolean; requiresPassword?: boolean; requiresLogin?: boolean; disabled?: boolean };
  ui?: { showInfoPanel?: boolean; showTools?: boolean; showMaterials?: boolean; showTiming?: boolean };
  deployment?: { version?: number; status?: string };
  tools?: string[];
  capabilities?: string[];
  materials?: Array<Record<string, unknown>>;
  requestActions?: RequestAction[];
};

function tokenFromHash(): string {
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
  const params = new URLSearchParams(hash);
  return params.get('token') || params.get('t') || '';
}

function conversationStorageKey(channelId: string, token: string): string {
  const credentialScope = token ? token.slice(-16) : 'site';
  return `ai-service-chat-conversation:${channelId}:${credentialScope}`;
}

function storedConversation(channelId: string, token: string): ConversationState | null {
  if (!channelId) return null;
  try {
    const storage = token ? window.sessionStorage : window.localStorage;
    const raw = storage?.getItem(conversationStorageKey(channelId, token));
    const parsed = raw ? JSON.parse(raw) as ConversationState : null;
    return parsed?.id ? parsed : null;
  } catch {
    return null;
  }
}

type StreamEvent = { type?: string; text?: string; response?: unknown; error?: string };

class ApiRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function apiJson(url: string, token?: string, body?: Record<string, unknown>, method = 'POST') {
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: method === 'GET' ? undefined : body ? JSON.stringify(body) : '{}',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiRequestError(data.error || `HTTP ${response.status}`, response.status);
  return data;
}

function isInvalidResumeCredential(error: unknown): boolean {
  return error instanceof ApiRequestError && /Conversation resume credential is invalid|expired/i.test(error.message);
}

function restoredMessagesFromResponse(data: unknown): ChatMessage[] {
  const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  return Array.isArray(record.messages) ? record.messages.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const role = row.role === 'user' || row.role === 'assistant' || row.role === 'system' ? row.role : null;
    return role && typeof row.text === 'string' ? [{ role, text: row.text } as ChatMessage] : [];
  }) : [];
}

function assistantText(value: unknown): string {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (typeof record.text === 'string') return record.text;
  if (typeof record.answer === 'string') return record.answer;
  if (Array.isArray(record.messages)) return record.messages.map((item) => typeof item === 'string' ? item : JSON.stringify(item)).join('\n');
  return JSON.stringify(value, null, 2);
}

function toolsFromResponse(value: unknown): ToolSummary[] {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const provenance = record.provenance && typeof record.provenance === 'object' ? record.provenance as Record<string, unknown> : {};
  return Array.isArray(provenance.tools)
    ? provenance.tools.filter((item): item is ToolSummary => Boolean(item) && typeof item === 'object' && typeof (item as ToolSummary).name === 'string')
    : [];
}

function citationsFromResponse(value: unknown): CitationSummary[] {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (!Array.isArray(record.citations)) return [];
  return record.citations.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const citedLineStart = Number(row.citedLineStart);
    const citedLineEnd = Number(row.citedLineEnd);
    if (typeof row.path !== 'string' || !Number.isInteger(citedLineStart) || !Number.isInteger(citedLineEnd)) return [];
    return [{ title: typeof row.title === 'string' && row.title.trim() ? row.title.trim() : row.path.split('/').pop()?.replace(/\.(md|txt)$/i, '') || i18n.t('aiServices.publicChat.publicMaterial'), path: row.path, citedLineStart, citedLineEnd, label: typeof row.label === 'string' ? row.label : undefined }];
  });
}

function friendlyToolName(name: string): string {
  const known = ['knowledge_search', 'knowledge_read', 'WebSearch', 'WebFetch'];
  return known.includes(name) ? i18n.t(`aiServices.publicChat.tools.${name}`) : i18n.t('aiServices.publicChat.tools.default');
}

function formatElapsed(ms?: number): string {
  if (!ms && ms !== 0) return '';
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  return i18n.t('aiServices.publicChat.seconds', { count: (ms / 1000).toFixed(ms < 10000 ? 1 : 0) });
}

function materialLabel(item: Record<string, unknown>): string {
  for (const key of ['title', 'name', 'path', 'file', 'url', 'ref', 'id']) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return i18n.t('aiServices.publicChat.publicMaterial');
}

function materialMeta(item: Record<string, unknown>): string {
  const parts = ['kind', 'type', 'source', 'updatedAt'].map((key) => typeof item[key] === 'string' ? String(item[key]) : '').filter(Boolean);
  return parts.join(' · ');
}

function AgentFaceMark({ face, name, theme, className = 'h-8 w-8' }: { face?: string; name: string; theme: ThemeMode; className?: string }) {
  const light = theme === 'light';
  const characterId = characterFace(face);
  const imageUrl = agentFaceImageUrl(face);
  if (characterId) return <AgentCharacterAvatar id={characterId} className={`${className} shrink-0 rounded-full`} variant="list" title={name} />;
  if (imageUrl) return <img src={imageUrl} alt="" className={`${className} shrink-0 rounded-full object-cover`} aria-hidden="true" />;
  if (face && !face.startsWith('character:') && !face.startsWith('generated:')) return <span className={`${className} flex shrink-0 items-center justify-center rounded-full border text-sm ${light ? 'border-teal-200 bg-teal-50 text-teal-700' : 'border-primary-500/30 bg-primary-500/12 text-primary-100'}`} title={name}>{face}</span>;
  return <span className={`${className} flex shrink-0 items-center justify-center rounded-full border text-sm ${light ? 'border-teal-200 bg-teal-50 text-teal-700' : 'border-primary-500/30 bg-primary-500/12 text-primary-100'}`} title={name}>✦</span>;
}

function MessageBubble({ message, theme, showTiming, showTools, agentFace, agentName, isLive = false }: { message: ChatMessage; theme: ThemeMode; showTiming: boolean; showTools: boolean; agentFace?: string; agentName: string; isLive?: boolean }) {
  const { t } = useTranslation('common');
  const light = theme === 'light';
  const [copied, setCopied] = React.useState(false);
  const [feedback, setFeedback] = React.useState<'helpful' | 'unhelpful' | null>(null);
  const copyAnswer = async () => {
    try {
      await navigator.clipboard.writeText(message.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch { /* Clipboard may be unavailable in restricted browser contexts. */ }
  };
  if (message.role === 'system') return (
    <div className={`mx-auto max-w-2xl rounded-xl border px-4 py-3 text-center text-xs leading-5 ${light ? 'border-slate-200 bg-white/75 text-slate-500 shadow-sm' : 'border-surface-800 bg-surface-900/60 text-surface-500'}`}>
      {message.text}
    </div>
  );
  const isUser = message.role === 'user';
  return (
    <div className={`flex w-full gap-3 ${isUser ? 'justify-end' : 'justify-start'}`}>
      {!isUser && <AgentFaceMark face={agentFace} name={agentName} theme={theme} className="mt-1 h-8 w-8" />}
      <div className="flex max-w-[min(720px,85%)] flex-col gap-1">
        <div className={`rounded-2xl px-4 py-3 text-[15px] leading-7 shadow-sm [word-break:keep-all] ${isUser ? light ? 'rounded-br-md bg-slate-900 text-white whitespace-pre-wrap' : 'rounded-br-md bg-primary-500/18 text-primary-50 ring-1 ring-primary-400/25 whitespace-pre-wrap' : light ? 'public-ai-rich-light rounded-bl-md border border-slate-200 bg-white text-slate-800' : 'rounded-bl-md border border-surface-800 bg-surface-900/85 text-surface-100'}`}>
          {isUser || isLive ? <span className="whitespace-pre-wrap">{message.text || ' '}</span> : <RichContent text={message.text} colorMode={theme} />}
        </div>
        {!isUser && !isLive && Boolean(message.citations?.length) && <div className={`mt-1 rounded-xl border px-3 py-2 ${light ? 'border-slate-200 bg-slate-50' : 'border-surface-800 bg-surface-950/55'}`}>
          <div className={`text-[11px] font-semibold ${light ? 'text-slate-500' : 'text-surface-500'}`}>{t('aiServices.publicChat.answerSources')}</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {message.citations?.map((citation, index) => <span key={`${citation.path}-${citation.citedLineStart}-${citation.citedLineEnd}`} title={citation.path} className={`rounded-full border px-2.5 py-1 text-xs ${light ? 'border-teal-200 bg-white text-teal-800' : 'border-primary-500/30 bg-primary-500/10 text-primary-100'}`}>[{index + 1}] {citation.title} · {citation.citedLineStart}–{citation.citedLineEnd}{t('aiServices.publicChat.lineSuffix')}</span>)}
          </div>
        </div>}
        {!isUser && !isLive && <div className={`flex flex-wrap items-center gap-1.5 px-1 text-xs ${light ? 'text-slate-500' : 'text-surface-500'}`}>
          {showTools && message.tools?.map((tool) => <span key={`${tool.name}-${JSON.stringify(tool.input || {})}`} className={`rounded-full border px-2 py-0.5 ${light ? 'border-slate-200 bg-slate-50 text-slate-600' : 'border-surface-800 bg-surface-900/60 text-surface-400'}`}>{friendlyToolName(tool.name)}</span>)}
          {showTiming && message.elapsedMs !== undefined && <span className="px-1">{formatElapsed(message.elapsedMs)}</span>}
          <span className="flex-1" />
          <button type="button" onClick={() => void copyAnswer()} className={`rounded-lg px-2 py-1 font-semibold ${light ? 'hover:bg-slate-100' : 'hover:bg-surface-800'}`} aria-label={t('aiServices.publicChat.copyAnswer')}>{copied ? t('aiServices.publicChat.copied') : t('aiServices.publicChat.copy')}</button>
          <button type="button" onClick={() => setFeedback('helpful')} className={`rounded-lg px-2 py-1 ${feedback === 'helpful' ? light ? 'bg-teal-50 text-teal-800' : 'bg-primary-500/15 text-primary-100' : light ? 'hover:bg-slate-100' : 'hover:bg-surface-800'}`} aria-label={t('aiServices.publicChat.helpfulAnswer')}>{t('aiServices.publicChat.helpful')}</button>
          <button type="button" onClick={() => setFeedback('unhelpful')} className={`rounded-lg px-2 py-1 ${feedback === 'unhelpful' ? light ? 'bg-amber-50 text-amber-800' : 'bg-amber-500/15 text-amber-100' : light ? 'hover:bg-slate-100' : 'hover:bg-surface-800'}`} aria-label={t('aiServices.publicChat.unhelpfulAnswer')}>{t('aiServices.publicChat.unhelpful')}</button>
        </div>}
      </div>
    </div>
  );
}

export function PublicAIServiceChat() {
  const { t } = useTranslation('common');
  const { channelId = '' } = useParams();
  const [token, setToken] = React.useState(() => tokenFromHash());
  const [theme, setTheme] = React.useState<ThemeMode>(() => {
    const saved = window.localStorage?.getItem('ai-service-chat-theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  });
  const [metadata, setMetadata] = React.useState<SiteMetadata | null>(null);
  const [metadataError, setMetadataError] = React.useState('');
  const [requestAction, setRequestAction] = React.useState<RequestAction | null>(null);
  const [requestSubject, setRequestSubject] = React.useState('');
  const [requestBody, setRequestBody] = React.useState('');
  const [requestContact, setRequestContact] = React.useState<Record<string, string>>({});
  const [requestStatus, setRequestStatus] = React.useState('');
  const [requestBusy, setRequestBusy] = React.useState(false);
  const [conversation, setConversation] = React.useState<ConversationState | null>(() => storedConversation(channelId, token));
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [accessPassword, setAccessPassword] = React.useState('');
  const [accessUnlocked, setAccessUnlocked] = React.useState(false);
  const [input, setInput] = React.useState('');
  const [queuedMessages, setQueuedMessages] = React.useState<QueuedMessage[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [startedAt, setStartedAt] = React.useState<number | null>(null);
  const [elapsedNow, setElapsedNow] = React.useState(0);
  const [error, setError] = React.useState('');
  const [failedPrompt, setFailedPrompt] = React.useState('');
  const [showJumpToLatest, setShowJumpToLatest] = React.useState(false);
  const [showInfoDrawer, setShowInfoDrawer] = React.useState(false);
  const [restoredConversation, setRestoredConversation] = React.useState(false);
  const [conversationFiles, setConversationFiles] = React.useState<ConversationFile[]>([]);
  const [uploadBusy, setUploadBusy] = React.useState(false);
  const [uploadError, setUploadError] = React.useState('');
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const requestAbortRef = React.useRef<AbortController | null>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const isNearBottomRef = React.useRef(true);

  React.useEffect(() => {
    const sync = () => setToken(tokenFromHash());
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  React.useEffect(() => {
    const stored = storedConversation(channelId, token);
    setConversation(stored);
    setMessages([]);
    if (token || !stored?.resumeToken || metadata?.access?.mode === 'password') return;
    let live = true;
    void apiJson(`/api/ai-service-public/sites/${encodeURIComponent(channelId)}/conversations/${encodeURIComponent(stored.id)}/resume`, undefined, { resumeToken: stored.resumeToken, accessPassword: '' })
      .then((data) => {
        if (!live) return;
        const restoredMessages = restoredMessagesFromResponse(data);
        setMessages(restoredMessages);
        setRestoredConversation(restoredMessages.length > 0);
        void loadConversationFiles(stored).catch(() => setUploadError(t('aiServices.publicChat.filesLoadFailed')));
      })
      .catch((error) => {
        if (!live || !isInvalidResumeCredential(error)) return;
        window.localStorage?.removeItem(conversationStorageKey(channelId, token));
        setConversation(null);
      });
    return () => { live = false; };
  }, [channelId, metadata?.access?.mode, token]);

  React.useEffect(() => {
    window.localStorage?.setItem('ai-service-chat-theme', theme);
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  React.useEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    const syncViewportHeight = () => {
      const height = Math.round(viewport?.height || window.innerHeight);
      root.style.setProperty('--public-chat-viewport-height', `${height}px`);
    };
    syncViewportHeight();
    viewport?.addEventListener('resize', syncViewportHeight);
    viewport?.addEventListener('scroll', syncViewportHeight);
    window.addEventListener('resize', syncViewportHeight);
    return () => {
      viewport?.removeEventListener('resize', syncViewportHeight);
      viewport?.removeEventListener('scroll', syncViewportHeight);
      window.removeEventListener('resize', syncViewportHeight);
      root.style.removeProperty('--public-chat-viewport-height');
    };
  }, []);

  React.useEffect(() => {
    if (!showInfoDrawer) return undefined;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setShowInfoDrawer(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [showInfoDrawer]);

  React.useEffect(() => {
    let live = true;
    setMetadataError('');
    void apiJson(`/api/ai-service-public/sites/${encodeURIComponent(channelId)}/metadata`, undefined, undefined, 'GET')
      .then((data) => { if (live) { const next = data as SiteMetadata; setMetadata(next); setAccessUnlocked(next.access?.mode !== 'password'); } })
      .catch((err) => { if (live) setMetadataError(err instanceof Error ? err.message : t('aiServices.publicChat.metadataLoadFailed')); });
    return () => { live = false; };
  }, [channelId]);

  React.useEffect(() => {
    if (!busy || startedAt == null) { setElapsedNow(0); return undefined; }
    const tick = () => setElapsedNow(performance.now() - startedAt);
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [busy, startedAt]);

  const scrollToLatest = React.useCallback((behavior: ScrollBehavior = 'smooth') => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior });
    isNearBottomRef.current = true;
    setShowJumpToLatest(false);
  }, []);

  const handleConversationScroll = React.useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 96;
    isNearBottomRef.current = nearBottom;
    if (nearBottom) setShowJumpToLatest(false);
  }, []);

  React.useEffect(() => {
    if (isNearBottomRef.current) scrollToLatest(messages.length > 1 ? 'smooth' : 'auto');
    else if (messages.length > 0) setShowJumpToLatest(true);
  }, [messages, busy, scrollToLatest]);

  React.useLayoutEffect(() => {
    const node = inputRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 160)}px`;
    node.style.overflowY = node.scrollHeight > 160 ? 'auto' : 'hidden';
  }, [input]);

  const createConversation = async (): Promise<ConversationState> => {
    const base = token ? 'channels' : 'sites';
    const created = await apiJson(`/api/ai-service-public/${base}/${encodeURIComponent(channelId)}/conversations`, token || undefined, token ? undefined : { accessPassword });
    const next: ConversationState = {
      id: String(created.id || ''),
      deploymentId: typeof created.deploymentId === 'string' ? created.deploymentId : undefined,
      resumeToken: typeof created.resumeToken === 'string' ? created.resumeToken : undefined,
      resumeExpiresAt: typeof created.expiresAt === 'string' ? created.expiresAt : undefined,
    };
    if (!next.id) throw new Error('Session id missing');
    setConversation(next);
    setRestoredConversation(false);
    const storage = token ? window.sessionStorage : window.localStorage;
    storage?.setItem(conversationStorageKey(channelId, token), JSON.stringify(next));
    return next;
  };

  const ensureConversation = async (): Promise<ConversationState> => conversation || createConversation();

  const loadConversationFiles = React.useCallback(async (activeConversation: ConversationState, password = accessPassword) => {
    if (token) return;
    if (!activeConversation.resumeToken) return;
    const query = new URLSearchParams({ resumeToken: activeConversation.resumeToken, ...(password ? { accessPassword: password } : {}) });
    const response = await apiJson(`/api/ai-service-public/sites/${encodeURIComponent(channelId)}/conversations/${encodeURIComponent(activeConversation.id)}/files?${query.toString()}`, undefined, undefined, 'GET');
    setConversationFiles(Array.isArray(response.files) ? response.files as ConversationFile[] : []);
  }, [accessPassword, channelId, token]);

  const uploadConversationFile = async (file: File) => {
    if (token) return;
    const activeConversation = await ensureConversation();
    setUploadBusy(true); setUploadError('');
    try {
      const form = new FormData();
      form.append('file', file);
      if (!activeConversation.resumeToken) throw new Error(t('aiServices.publicChat.fileAccessMissingNewConversation'));
      form.append('resumeToken', activeConversation.resumeToken);
      if (accessPassword) form.append('accessPassword', accessPassword);
      const response = await fetch(`/api/ai-service-public/sites/${encodeURIComponent(channelId)}/conversations/${encodeURIComponent(activeConversation.id)}/files`, { method: 'POST', body: form });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      await loadConversationFiles(activeConversation);
    } catch (err) { setUploadError(err instanceof Error ? err.message : t('aiServices.publicChat.fileUploadFailed')); }
    finally { setUploadBusy(false); if (fileInputRef.current) fileInputRef.current.value = ''; }
  };

  const removeConversationFile = async (fileId: string) => {
    if (!conversation || token) return;
    setUploadError('');
    try {
      if (!conversation.resumeToken) throw new Error(t('aiServices.publicChat.fileAccessMissing'));
      const query = new URLSearchParams({ resumeToken: conversation.resumeToken, ...(accessPassword ? { accessPassword } : {}) });
      const response = await fetch(`/api/ai-service-public/sites/${encodeURIComponent(channelId)}/conversations/${encodeURIComponent(conversation.id)}/files/${encodeURIComponent(fileId)}?${query.toString()}`, { method: 'DELETE' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setConversationFiles((current) => current.filter((item) => item.id !== fileId));
    } catch (err) { setUploadError(err instanceof Error ? err.message : t('aiServices.publicChat.fileDeleteFailed')); }
  };

  const unlockPassword = async () => {
    if (!accessPassword.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const stored = storedConversation(channelId, token);
      if (stored?.resumeToken) {
        try {
          const data = await apiJson(`/api/ai-service-public/sites/${encodeURIComponent(channelId)}/conversations/${encodeURIComponent(stored.id)}/resume`, undefined, { resumeToken: stored.resumeToken, accessPassword });
          const restoredMessages = restoredMessagesFromResponse(data);
          setConversation(stored);
          setMessages(restoredMessages);
          setRestoredConversation(restoredMessages.length > 0);
          await loadConversationFiles(stored, accessPassword);
        } catch (resumeError) {
          if (!isInvalidResumeCredential(resumeError)) throw resumeError;
          window.localStorage?.removeItem(conversationStorageKey(channelId, token));
          setConversation(null);
          await createConversation();
        }
      } else {
        await createConversation();
      }
      setAccessUnlocked(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('aiServices.publicChat.passwordCheckFailed'));
    } finally { setBusy(false); }
  };

  const runMessage = React.useCallback(async (text: string, options?: { echoUser?: boolean }) => {
    const start = performance.now();
    const controller = new AbortController();
    requestAbortRef.current = controller;
    setStartedAt(start);
    setBusy(true); setError(''); setFailedPrompt('');
    isNearBottomRef.current = true;
    if (options?.echoUser !== false) setMessages((current) => [...current, { role: 'user', text }]);
    try {
      const activeConversation = await ensureConversation();
      if (token) {
        const response = await apiJson(`/api/ai-service-public/channels/${encodeURIComponent(channelId)}/conversations/${encodeURIComponent(activeConversation.id)}/messages`, token, { message: text });
        setMessages((current) => [...current, { role: 'assistant', text: assistantText(response), elapsedMs: performance.now() - start, tools: toolsFromResponse(response), citations: citationsFromResponse(response) }]);
        return;
      }
      const response = await fetch(`/api/ai-service-public/sites/${encodeURIComponent(channelId)}/conversations/${encodeURIComponent(activeConversation.id)}/stream`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text, accessPassword }), signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finalResponse: unknown;
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as StreamEvent;
          if (event.type === 'text' && typeof event.text === 'string') setMessages((current) => {
            const last = current[current.length - 1];
            if (last?.role === 'assistant') return current.map((message, index) => index === current.length - 1 ? { ...message, text: event.text! } : message);
            return [...current, { role: 'assistant', text: event.text! }];
          });
          if (event.type === 'done') finalResponse = event.response;
          if (event.type === 'error') throw new Error(event.error || t('aiServices.publicChat.responseFailed'));
        }
        if (done) break;
      }
      if (buffer.trim()) {
        const event = JSON.parse(buffer) as StreamEvent;
        if (event.type === 'text' && typeof event.text === 'string') setMessages((current) => current.map((message, index) => index === current.length - 1 && message.role === 'assistant' ? { ...message, text: event.text! } : message));
        if (event.type === 'done') finalResponse = event.response;
        if (event.type === 'error') throw new Error(event.error || t('aiServices.publicChat.responseFailed'));
      }
      setMessages((current) => current.map((message, index) => index === current.length - 1 && message.role === 'assistant' ? { ...message, text: message.text || assistantText(finalResponse), elapsedMs: performance.now() - start, tools: toolsFromResponse(finalResponse), citations: citationsFromResponse(finalResponse) } : message));
    } catch (err) {
      if (controller.signal.aborted) {
        setMessages((current) => current.filter((message, index) => !(index === current.length - 1 && message.role === 'assistant' && !message.text)));
      } else {
        const message = err instanceof Error ? err.message : t('aiServices.publicChat.responseFailed');
        setError(message);
        setFailedPrompt(text);
      }
    } finally { requestAbortRef.current = null; setBusy(false); setStartedAt(null); }
  }, [accessPassword, channelId, conversation, token]);

  React.useEffect(() => {
    if (busy || queuedMessages.length === 0) return;
    const [next, ...rest] = queuedMessages;
    setQueuedMessages(rest);
    void runMessage(next.text);
  }, [busy, queuedMessages, runMessage]);

  const cancelQueue = () => setQueuedMessages([]);
  const stopResponse = () => requestAbortRef.current?.abort();
  const startNewConversation = () => {
    if (busy) return;
    const storage = token ? window.sessionStorage : window.localStorage;
    storage?.removeItem(conversationStorageKey(channelId, token));
    setConversation(null);
    setMessages([]);
    setConversationFiles([]);
    setUploadError('');
    setQueuedMessages([]);
    setError('');
    setFailedPrompt('');
    setRestoredConversation(false);
    setShowInfoDrawer(false);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  const retryFailed = () => {
    if (!failedPrompt || busy) return;
    void runMessage(failedPrompt, { echoUser: false });
  };

  const sendSuggestion = (suggestion: string) => {
    if (busy) setQueuedMessages((current) => [...current, { id: globalThis.crypto?.randomUUID?.() || String(Date.now()), text: suggestion }]);
    else void runMessage(suggestion);
  };

  const submitCustomerRequest = async () => {
    if (!requestAction || !requestBody.trim()) return;
    setRequestBusy(true); setRequestStatus('');
    try {
      const activeConversation = conversation || await ensureConversation();
      const data = await apiJson(`/api/ai-service-public/sites/${encodeURIComponent(channelId)}/conversations/${encodeURIComponent(activeConversation.id)}/requests`, undefined, {
        actionId: requestAction.id,
        subject: requestSubject,
        body: requestBody,
        contact: requestContact,
        idempotencyKey: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${requestAction.id}`,
        accessPassword,
      });
      setRequestStatus(typeof data.message === 'string' ? data.message : t('aiServices.publicChat.requestReceived'));
      setRequestSubject(''); setRequestBody(''); setRequestContact({});
    } catch (requestError) {
      setRequestStatus(requestError instanceof Error ? requestError.message : t('aiServices.publicChat.requestFailed'));
    } finally { setRequestBusy(false); }
  };

  const send = (immediateInput?: string) => {
    const text = (typeof immediateInput === 'string' ? immediateInput : input).trim();
    if (!text || !channelId || accessBlocked) return;
    setInput(''); setError('');
    if (busy) {
      setQueuedMessages((current) => [...current, { id: globalThis.crypto?.randomUUID?.() || String(Date.now()), text }]);
      return;
    }
    void runMessage(text);
  };

  const agentName = metadata?.name || t('aiServices.publicChat.defaultAgentName');
  const agentFace = metadata?.face;
  const accessMode = metadata?.access?.mode || 'unlisted';
  const accessBlocked = !token && (accessMode === 'disabled' || accessMode === 'login_required' || (accessMode === 'password' && !accessUnlocked));
  const disabled = !channelId || accessBlocked;
  const light = theme === 'light';
  const showInfoPanel = metadata?.ui?.showInfoPanel !== false;
  const showTools = metadata?.ui?.showTools !== false;
  const showMaterials = metadata?.ui?.showMaterials !== false;
  const showTiming = metadata?.ui?.showTiming !== false;
  const tools = showTools ? metadata?.tools?.length ? metadata.tools : metadata?.capabilities || [] : [];
  const materials = showMaterials ? metadata?.materials || [] : [];
  const suggestions = [
    t('aiServices.publicChat.suggestions.capabilities'),
    materials.length > 0 ? t('aiServices.publicChat.suggestions.materials') : t('aiServices.publicChat.suggestions.example'),
    t('aiServices.publicChat.suggestions.questions'),
  ];

  const publicThemeVariables = light ? {
    '--th-prose-body': '#1f2937',
    '--th-prose-heading': '#0f172a',
    '--th-prose-muted': '#4b5563',
    '--th-prose-link': '#0f766e',
    '--th-prose-code-bg': '#f1f5f9',
    '--th-prose-code-border': '#e2e8f0',
    '--th-prose-code-text': '#92400e',
    '--th-prose-pre-bg': '#f8fafc',
    '--th-prose-pre-border': '#e2e8f0',
    '--th-prose-pre-text': '#1e293b',
    '--th-prose-table-border': '#dbe4e8',
    '--th-prose-th-bg': '#f1f5f9',
    '--th-prose-th-text': '#334155',
    '--th-prose-td-text': '#334155',
    '--th-prose-strong': '#111827',
    '--th-prose-hr': '#e2e8f0',
  } as React.CSSProperties : undefined;

  return (
    <main className={`flex h-[var(--public-chat-viewport-height,100dvh)] min-h-0 max-h-[var(--public-chat-viewport-height,100dvh)] flex-col overflow-hidden ${light ? 'bg-slate-50 text-slate-900' : 'bg-surface-950 text-surface-100'}`} lang={i18n.resolvedLanguage || i18n.language} data-theme={theme} style={publicThemeVariables}>
      <header className={`shrink-0 border-b px-3 py-3 backdrop-blur-md sm:px-4 ${light ? 'border-slate-200 bg-white/85' : 'border-surface-800 bg-surface-900/85'}`}>
        <div className="mx-auto flex max-w-6xl items-center gap-2 sm:gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
            <AgentFaceMark face={agentFace} name={agentName} theme={theme} className="h-9 w-9 rounded-xl" />
            <div className="min-w-0 flex-1 overflow-hidden">
              <div className={`truncate text-sm font-bold ${light ? 'text-slate-900' : 'text-surface-100'}`}>{agentName}</div>
              <div className={`hidden truncate text-[11px] sm:block ${light ? 'text-slate-500' : 'text-surface-500'}`}>Tower AI Service · {metadata?.channelName || t('aiServices.publicChat.publicWebsite')} · v{metadata?.deployment?.version || '-'}</div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
            <button type="button" onClick={startNewConversation} disabled={busy || !conversation} className={`hidden whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs font-semibold transition disabled:opacity-40 md:inline-flex ${light ? 'text-slate-600 hover:bg-slate-100' : 'text-surface-300 hover:bg-surface-800'}`}>{t('aiServices.publicChat.newConversation')}</button>
            {showInfoPanel && <button type="button" onClick={() => setShowInfoDrawer(true)} className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-base font-semibold transition sm:h-auto sm:w-auto sm:whitespace-nowrap sm:px-2.5 sm:py-1.5 sm:text-xs ${light ? 'text-slate-600 hover:bg-slate-100' : 'text-surface-300 hover:bg-surface-800'}`} aria-label={t('aiServices.publicChat.aboutAi')} title={t('aiServices.publicChat.aboutAi')}><span aria-hidden="true" className="sm:hidden">ⓘ</span><span className="hidden sm:inline">{t('aiServices.publicChat.aboutAi')}</span></button>}
            <button type="button" onClick={() => setTheme(light ? 'dark' : 'light')} className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-base font-semibold transition sm:h-auto sm:w-auto sm:whitespace-nowrap sm:px-2.5 sm:py-1.5 sm:text-xs ${light ? 'text-slate-600 hover:bg-slate-100' : 'text-surface-300 hover:bg-surface-800'}`} aria-label={light ? t('aiServices.publicChat.switchDark') : t('aiServices.publicChat.switchLight')} title={light ? t('aiServices.publicChat.switchDark') : t('aiServices.publicChat.switchLight')}><span aria-hidden="true" className="sm:hidden">{light ? '☾' : '☀'}</span><span className="hidden sm:inline">{light ? t('aiServices.publicChat.dark') : t('aiServices.publicChat.light')}</span></button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid min-h-0 w-full max-w-6xl flex-1 grid-cols-1 overflow-hidden">
        <section ref={scrollRef} onScroll={handleConversationScroll} className="relative min-h-0 overflow-y-auto px-4 py-6">
          <div className="mx-auto flex max-w-4xl flex-col gap-5">
            {restoredConversation && <div className={`mx-auto flex w-full max-w-2xl items-center justify-between gap-3 rounded-xl border px-3 py-2 text-xs ${light ? 'border-teal-200 bg-teal-50 text-teal-900' : 'border-primary-500/25 bg-primary-500/10 text-primary-100'}`}><span>{t('aiServices.publicChat.restoredConversation')}</span><button type="button" onClick={startNewConversation} disabled={busy} className="shrink-0 font-semibold underline underline-offset-2">{t('aiServices.publicChat.startNewConversation')}</button></div>}
            {token && <div className={`mx-auto rounded-full border px-3 py-1 text-[11px] ${light ? 'border-slate-200 bg-white/75 text-slate-500' : 'border-surface-800 bg-surface-900/60 text-surface-500'}`}>{t('aiServices.publicChat.credentialLinkNotice')}</div>}
            {!token && accessMode === 'password' && !accessUnlocked && <div className={`mx-auto w-full max-w-xl rounded-2xl border p-4 text-center shadow-sm ${light ? 'border-slate-200 bg-white text-slate-700' : 'border-surface-800 bg-surface-900/80 text-surface-200'}`}>
              <div className="text-sm font-bold">{t('aiServices.publicChat.passwordRequiredTitle')}</div>
              <p className={`mt-1 text-xs ${light ? 'text-slate-500' : 'text-surface-500'}`}>{t('aiServices.publicChat.passwordRequiredDescription')}</p>
              <form className="mt-3 flex gap-2" onSubmit={(event) => { event.preventDefault(); void unlockPassword(); }}>
                <input type="password" value={accessPassword} onChange={(event) => setAccessPassword(event.target.value)} placeholder={t('aiServices.publicChat.password')} className={`min-w-0 flex-1 rounded-xl border px-3 py-2 text-sm outline-none ${light ? 'border-slate-200 bg-slate-50 text-slate-900 focus:border-teal-400' : 'border-surface-700 bg-surface-950 text-surface-100 focus:border-primary-500'}`} />
                <button type="submit" disabled={busy || !accessPassword.trim()} className={`rounded-xl border px-4 py-2 text-sm font-bold disabled:opacity-40 ${light ? 'border-slate-300 bg-slate-900 text-white' : 'border-primary-400/35 bg-primary-500/18 text-primary-100'}`}>{t('aiServices.publicChat.enter')}</button>
              </form>
            </div>}
            {!token && accessMode === 'login_required' && <div className={`mx-auto max-w-xl rounded-2xl border p-4 text-center text-sm ${light ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-amber-500/25 bg-amber-500/10 text-amber-200'}`}>{t('aiServices.publicChat.loginRequired')}</div>}
            {!token && accessMode === 'disabled' && <div className={`mx-auto max-w-xl rounded-2xl border p-4 text-center text-sm ${light ? 'border-red-200 bg-red-50 text-red-700' : 'border-red-500/25 bg-red-500/10 text-red-200'}`}>{t('aiServices.publicChat.accessDisabled')}</div>}
            {messages.length === 0 && !busy && !accessBlocked && <section className="mx-auto flex w-full max-w-2xl flex-col items-center py-10 text-center">
              <AgentFaceMark face={agentFace} name={agentName} theme={theme} className="h-14 w-14 rounded-2xl" />
              <h1 className={`mt-5 text-xl font-bold ${light ? 'text-slate-900' : 'text-surface-100'}`}>{t('aiServices.publicChat.askAgent', { name: agentName })}</h1>
              <p className={`mt-2 max-w-lg text-sm leading-6 ${light ? 'text-slate-600' : 'text-surface-400'}`}>{metadata?.description || t('aiServices.publicChat.defaultDescription')}</p>
              <div className="mt-6 flex max-w-xl flex-wrap justify-center gap-2">
                {suggestions.map((suggestion) => <button key={suggestion} type="button" onClick={() => sendSuggestion(suggestion)} className={`rounded-full border px-4 py-2 text-sm text-left transition ${light ? 'border-slate-200 bg-white text-teal-900 hover:border-teal-300 hover:bg-teal-50' : 'border-surface-700 bg-surface-900 text-surface-200 hover:border-primary-500/50 hover:bg-primary-500/10'}`}>{suggestion}</button>)}
              </div>
            </section>}
            {!accessBlocked && Boolean(metadata?.requestActions?.length) && <div className="mx-auto flex w-full max-w-2xl flex-wrap justify-center gap-2">
              {metadata?.requestActions?.map((action) => <button key={action.id} type="button" onClick={() => { setRequestAction(action); setRequestStatus(''); }} className={`rounded-xl border px-4 py-2 text-sm font-semibold transition ${light ? 'border-teal-300 bg-teal-50 text-teal-900 hover:bg-teal-100' : 'border-primary-500/35 bg-primary-500/10 text-primary-100 hover:bg-primary-500/20'}`}>{action.label}</button>)}
            </div>}
            {messages.map((message, index) => <MessageBubble key={`${message.role}-${index}`} message={message} theme={theme} showTiming={showTiming} showTools={showTools} agentFace={agentFace} agentName={agentName} isLive={busy && index === messages.length - 1 && message.role === 'assistant'} />)}
            {busy && messages[messages.length - 1]?.role !== 'assistant' && <div className={`flex items-center gap-3 text-sm ${light ? 'text-slate-600' : 'text-surface-400'}`}>
              <AgentFaceMark face={agentFace} name={agentName} theme={theme} className="h-8 w-8" />
              <div className={`rounded-2xl border px-4 py-3 ${light ? 'border-slate-200 bg-white' : 'border-surface-800 bg-surface-900/80'}`}>{t('aiServices.publicChat.responding')} {showTiming && <span className="font-mono">{formatElapsed(elapsedNow)}</span>}</div>
            </div>}
          </div>
          {showJumpToLatest && <button type="button" onClick={() => scrollToLatest()} className={`sticky bottom-2 mx-auto mt-4 flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-semibold shadow-lg transition ${light ? 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50' : 'border-surface-700 bg-surface-900 text-surface-200 hover:bg-surface-800'}`}>{t('aiServices.publicChat.newMessages')}</button>}
        </section>

        {requestAction && <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label={requestAction.label}>
          <button type="button" className="absolute inset-0 bg-black/40" onClick={() => { if (!requestBusy) setRequestAction(null); }} aria-label={t('aiServices.publicChat.closeRequest')} />
          <section className={`relative w-full max-w-lg rounded-t-2xl border p-5 shadow-2xl sm:rounded-2xl ${light ? 'border-slate-200 bg-white' : 'border-surface-700 bg-surface-950'}`}>
            <h2 className="text-lg font-bold">{requestAction.label}</h2>
            {requestAction.description && <p className={`mt-1 text-sm ${light ? 'text-slate-600' : 'text-surface-400'}`}>{requestAction.description}</p>}
            <input value={requestSubject} onChange={(event) => setRequestSubject(event.target.value)} placeholder={t('aiServices.publicChat.optionalRequestTitle')} className={`mt-4 w-full rounded-xl border px-3 py-2 text-sm outline-none ${light ? 'border-slate-200 bg-slate-50' : 'border-surface-700 bg-surface-900'}`} />
            <textarea value={requestBody} onChange={(event) => setRequestBody(event.target.value)} rows={5} placeholder={t('aiServices.publicChat.requestBodyPlaceholder')} className={`mt-2 w-full resize-y rounded-xl border px-3 py-2 text-sm outline-none ${light ? 'border-slate-200 bg-slate-50' : 'border-surface-700 bg-surface-900'}`} />
            {requestAction.fields.map((field) => <input key={field} value={requestContact[field] || ''} onChange={(event) => setRequestContact((current) => ({ ...current, [field]: event.target.value }))} placeholder={field === 'name' ? t('aiServices.publicChat.name') : field === 'email' ? t('aiServices.publicChat.email') : t('aiServices.publicChat.phone')} className={`mt-2 w-full rounded-xl border px-3 py-2 text-sm outline-none ${light ? 'border-slate-200 bg-slate-50' : 'border-surface-700 bg-surface-900'}`} />)}
            {requestStatus && <p className={`mt-3 text-sm ${light ? 'text-teal-800' : 'text-primary-100'}`}>{requestStatus}</p>}
            <div className="mt-4 flex justify-end gap-2"><button type="button" onClick={() => setRequestAction(null)} disabled={requestBusy} className={`rounded-xl px-4 py-2 text-sm ${light ? 'text-slate-600 hover:bg-slate-100' : 'text-surface-300 hover:bg-surface-800'}`}>{t('aiServices.publicChat.close')}</button><button type="button" onClick={() => void submitCustomerRequest()} disabled={requestBusy || !requestBody.trim()} className={`rounded-xl border px-4 py-2 text-sm font-bold disabled:opacity-40 ${light ? 'border-slate-900 bg-slate-900 text-white' : 'border-primary-400/35 bg-primary-500/18 text-primary-100'}`}>{requestBusy ? t('aiServices.publicChat.submitting') : requestAction.confirmationLabel}</button></div>
          </section>
        </div>}

        {showInfoPanel && showInfoDrawer && <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={t('aiServices.publicChat.aboutAi')}>
          <button type="button" className="absolute inset-0 bg-black/35 backdrop-blur-[1px]" onClick={() => setShowInfoDrawer(false)} aria-label={t('aiServices.publicChat.closeAiInfo')} />
          <aside className={`relative h-full w-full max-w-md overflow-y-auto border-l p-5 shadow-2xl ${light ? 'border-slate-200 bg-white text-slate-900' : 'border-surface-800 bg-surface-950 text-surface-100'}`}>
            <div className="flex items-start justify-between gap-4">
              <div><div className={`text-xs font-semibold ${light ? 'text-teal-700' : 'text-primary-200'}`}>{t('aiServices.publicChat.aboutAi')}</div><h2 className="mt-1 text-lg font-bold">{metadata?.name || t('aiServices.publicChat.loadingDeploymentInfo')}</h2></div>
              <button type="button" onClick={() => setShowInfoDrawer(false)} className={`rounded-lg px-3 py-1.5 text-sm ${light ? 'hover:bg-slate-100' : 'hover:bg-surface-800'}`}>{t('aiServices.publicChat.close')}</button>
            </div>
            <p className={`mt-4 text-sm leading-6 ${light ? 'text-slate-600' : 'text-surface-400'}`}>{metadata?.description || metadataError || t('aiServices.publicChat.loadingPublicInfo')}</p>
            <section className={`mt-6 border-t pt-5 ${light ? 'border-slate-200' : 'border-surface-800'}`}>
              <h3 className="text-sm font-bold">{t('aiServices.publicChat.capabilities')}</h3>
              <div className="mt-3 flex flex-wrap gap-2">{tools.length ? tools.map((tool) => <span key={tool} className={`rounded-full border px-3 py-1.5 text-xs ${light ? 'border-teal-200 bg-teal-50 text-teal-800' : 'border-primary-500/25 bg-primary-500/10 text-primary-100'}`}>{friendlyToolName(tool)}</span>) : <span className={`text-sm ${light ? 'text-teal-900' : 'text-surface-500'}`}>{t('aiServices.publicChat.materialScopeOnly')}</span>}</div>
            </section>
            <section className={`mt-6 border-t pt-5 ${light ? 'border-slate-200' : 'border-surface-800'}`}>
              <h3 className="text-sm font-bold">{t('aiServices.publicChat.publishedMaterials')} <span className={`ml-1 font-normal ${light ? 'text-slate-500' : 'text-surface-500'}`}>{materials.length}{t('aiServices.publicChat.countSuffix')}</span></h3>
              <div className="mt-3 space-y-2">{materials.length ? materials.slice(0, 12).map((item, index) => <div key={`${materialLabel(item)}-${index}`} className={`rounded-xl border px-3 py-2.5 ${light ? 'border-slate-200 bg-slate-50' : 'border-surface-800 bg-surface-900/60'}`}><div className="text-sm font-semibold">{materialLabel(item)}</div>{materialMeta(item) && <div className={`mt-1 text-xs ${light ? 'text-slate-500' : 'text-surface-500'}`}>{materialMeta(item)}</div>}</div>) : <p className={`text-sm leading-6 ${light ? 'text-slate-500' : 'text-surface-500'}`}>{t('aiServices.publicChat.noPublishedMaterials')}</p>}</div>
            </section>
            <section className={`mt-6 border-t pt-5 text-sm ${light ? 'border-slate-200 text-slate-600' : 'border-surface-800 text-surface-400'}`}><div className="flex justify-between"><span>{t('aiServices.publicChat.currentVersion')}</span><strong>v{metadata?.deployment?.version || '-'}</strong></div><p className="mt-4 leading-6">{t('aiServices.publicChat.safetyDescription')}</p></section>
          </aside>
        </div>}
      </div>

      <footer className={`relative z-20 shrink-0 border-t px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur-md sm:px-4 ${light ? 'border-slate-200 bg-white/95' : 'border-surface-800 bg-surface-950/95'}`} data-public-chat-composer>
        <div className="mx-auto max-w-4xl">
          {error && <div className={`mb-2 flex items-center justify-between gap-3 rounded-xl border px-3 py-2 text-xs ${light ? 'border-red-200 bg-red-50 text-red-700' : 'border-red-500/25 bg-red-500/10 text-red-200'}`}>
            <span className="min-w-0">{t('aiServices.publicChat.couldNotRespond')} {error}</span>
            {failedPrompt && <button type="button" onClick={retryFailed} disabled={busy} className={`shrink-0 rounded-lg border px-2.5 py-1 font-semibold disabled:opacity-50 ${light ? 'border-red-300 bg-white hover:bg-red-100' : 'border-red-400/30 bg-red-500/10 hover:bg-red-500/20'}`}>{t('aiServices.publicChat.retry')}</button>}
          </div>}
          {queuedMessages.length > 0 && <div className={`mb-2 flex items-center justify-between rounded-xl border px-3 py-2 text-xs ${light ? 'border-teal-200 bg-teal-50 text-teal-800' : 'border-primary-500/25 bg-primary-500/10 text-primary-100'}`}>
            <span>{t('aiServices.publicChat.queueCount', { count: queuedMessages.length })}</span>
            <button type="button" onClick={cancelQueue} className="font-semibold underline underline-offset-2">{t('aiServices.publicChat.cancelAll')}</button>
          </div>}
          {!token && conversationFiles.length > 0 && <div className="mb-2 flex flex-wrap gap-2">{conversationFiles.map((file) => <span key={file.id} className={`inline-flex max-w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${light ? 'border-slate-200 bg-white text-slate-700' : 'border-surface-700 bg-surface-900 text-surface-300'}`}><span className="truncate">{file.name}</span><button type="button" onClick={() => void removeConversationFile(file.id)} className="font-bold opacity-65 hover:opacity-100" aria-label={t('aiServices.publicChat.deleteFile', { name: file.name })}>×</button></span>)}</div>}
          {uploadError && <div className={`mb-2 rounded-lg border px-3 py-2 text-xs ${light ? 'border-red-200 bg-red-50 text-red-700' : 'border-red-500/25 bg-red-500/10 text-red-200'}`}>{uploadError}</div>}
          <form className={`flex items-end gap-2 rounded-2xl border p-2 shadow-lg ${light ? 'border-slate-200 bg-white focus-within:border-teal-400' : 'border-surface-700 bg-surface-900/85 focus-within:border-primary-500/60'}`} onSubmit={(event) => { event.preventDefault(); send(inputRef.current?.value); }}>
            {!token && <><input ref={fileInputRef} type="file" accept=".txt,.csv,text/plain,text/csv" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadConversationFile(file); }} /><button type="button" onClick={() => fileInputRef.current?.click()} disabled={disabled || uploadBusy || conversationFiles.length >= 5} className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border text-lg transition disabled:opacity-40 ${light ? 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100' : 'border-surface-600 bg-surface-800 text-surface-100 hover:bg-surface-700'}`} aria-label={t('aiServices.publicChat.attachMaterial')} title={t('aiServices.publicChat.attachMaterialHint')}>{uploadBusy ? '…' : '+'}</button></>}
            <textarea ref={inputRef} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); send(event.currentTarget.value); } }} rows={1} placeholder={busy ? t('aiServices.publicChat.busyPlaceholder') : t('aiServices.publicChat.messagePlaceholder')} className={`max-h-40 min-h-10 flex-1 resize-none bg-transparent px-3 py-2 text-[15px] leading-6 outline-none ${light ? 'text-slate-900 placeholder:text-slate-400' : 'text-surface-100 placeholder:text-surface-600'}`} />
            {busy && <button type="button" onClick={stopResponse} className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border transition ${light ? 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100' : 'border-surface-600 bg-surface-800 text-surface-100 hover:bg-surface-700'}`} aria-label={t('aiServices.publicChat.stopResponse')}>■</button>}
            <button type="submit" disabled={disabled || !input.trim()} className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border transition disabled:opacity-40 ${light ? 'border-slate-300 bg-slate-900 text-white hover:bg-slate-700' : 'border-primary-400/35 bg-primary-500/18 text-primary-100 hover:bg-primary-500/25'}`} aria-label={busy ? t('aiServices.publicChat.addToQueue') : t('aiServices.publicChat.send')}>↗</button>
          </form>
          <div className={`mt-2 text-center text-[11px] ${light ? 'text-slate-400' : 'text-surface-600'}`}>{busy ? t('aiServices.publicChat.queueHint') : t('aiServices.publicChat.disclaimer')}</div>
        </div>
      </footer>
    </main>
  );
}

export default PublicAIServiceChat;
