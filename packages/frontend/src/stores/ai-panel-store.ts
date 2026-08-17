import { create } from 'zustand';
import type { SessionMeta } from '@tower/shared';
import type { ChatMessage, PendingQuestion } from './chat-store';
import { normalizeContentBlocks } from '../utils/message-parser';

export type AiPanelContextType = 'session';

export interface AiPanelFileAnchor {
  path: string;
  title?: string;
  language?: string;
}

interface AiPanelState {
  open: boolean;
  contextType: AiPanelContextType;
  contextId: string | null;      // parentSessionId
  /** Optional "current file" anchor for session-scoped side threads. */
  fileAnchor: AiPanelFileAnchor | null;
  threads: SessionMeta[];
  activeThreadId: string | null;
  messages: ChatMessage[];
  isStreaming: boolean;
  pendingQuestion: PendingQuestion | null;
  loading: boolean;

  setOpen: (open: boolean) => void;
  toggle: () => void;
  setContext: (type: AiPanelContextType, id: string | null, fileAnchor?: AiPanelFileAnchor | null) => void;
  setFileAnchor: (fileAnchor: AiPanelFileAnchor | null) => void;
  setThreads: (threads: SessionMeta[]) => void;
  addThread: (thread: SessionMeta) => void;
  removeThread: (id: string) => void;
  updateThreadMeta: (id: string, updates: Partial<SessionMeta>) => void;
  setActiveThreadId: (id: string | null) => void;
  setMessages: (messages: ChatMessage[]) => void;
  addMessage: (message: ChatMessage) => void;
  updateAssistantById: (id: string, content: ChatMessage['content'], timestamp?: number) => void;
  setStreaming: (v: boolean) => void;
  setPendingQuestion: (pq: PendingQuestion | null) => void;
  setLoading: (v: boolean) => void;
  reset: () => void;
}

export const useAiPanelStore = create<AiPanelState>((set) => ({
  open: false,
  contextType: 'session',
  contextId: null,
  fileAnchor: null,
  threads: [],
  activeThreadId: null,
  messages: [],
  isStreaming: false,
  pendingQuestion: null,
  loading: false,

  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
  setContext: (type, id, fileAnchor = null) => set({
    contextType: type,
    contextId: id,
    fileAnchor,
  }),
  setFileAnchor: (fileAnchor) => set({ fileAnchor }),
  setThreads: (threads) => set({ threads }),
  addThread: (thread) => set((s) => ({
    threads: [thread, ...s.threads],
  })),
  removeThread: (id) => set((s) => ({
    threads: s.threads.filter((t) => t.id !== id),
    activeThreadId: s.activeThreadId === id ? null : s.activeThreadId,
    messages: s.activeThreadId === id ? [] : s.messages,
    isStreaming: s.activeThreadId === id ? false : s.isStreaming,
    pendingQuestion: s.activeThreadId === id ? null : s.pendingQuestion,
  })),
  updateThreadMeta: (id, updates) => set((s) => {
    const idx = s.threads.findIndex((t) => t.id === id);
    if (idx === -1) return s;
    const threads = [...s.threads];
    threads[idx] = { ...threads[idx], ...updates };
    return { threads };
  }),
  setActiveThreadId: (id) => set({ activeThreadId: id }),
  setMessages: (messages) => set({ messages }),
  addMessage: (message) => set((s) => {
    if (s.messages.some((m) => m.id === message.id)) {
      console.warn('[ai-panel-store] duplicate message dropped:', message.id, message.role);
      return s;
    }
    return { messages: [...s.messages, message] };
  }),
  updateAssistantById: (id, content, timestamp) =>
    set((s) => {
      const idx = s.messages.findIndex((m) => m.id === id);
      if (idx === -1) return s;
      const msgs = [...s.messages];
      msgs[idx] = { ...msgs[idx], content, timestamp: timestamp || Date.now() };
      return { messages: msgs };
    }),
  setStreaming: (v) => set({ isStreaming: v }),
  setPendingQuestion: (pq) => set({ pendingQuestion: pq }),
  setLoading: (v) => set({ loading: v }),
  reset: () => set({
    open: false,
    contextType: 'session',
    contextId: null,
    fileAnchor: null,
    threads: [],
    activeThreadId: null,
    messages: [],
    isStreaming: false,
    pendingQuestion: null,
    loading: false,
  }),
}));

// ── API helpers ──

const authHeaders = (): Record<string, string> => {
  const tk = localStorage.getItem('token');
  return tk ? { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
};

export async function fetchPanelThreads(contextType: AiPanelContextType, contextId: string): Promise<SessionMeta[]> {
  const params = new URLSearchParams({ parentSessionId: contextId, includeProject: '1' });
  const res = await fetch(`/api/sessions?${params.toString()}`, { headers: authHeaders() });
  if (!res.ok) return [];
  return res.json();
}

export async function deletePanelThread(sessionId: string): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Failed to delete thread: ${res.status}`);
}

export async function createPanelThread(
  contextType: AiPanelContextType,
  contextId: string,
  engine?: string,
  opts: { scope?: 'session' | 'project'; projectId?: string | null } = {},
): Promise<SessionMeta> {
  const scope = opts.scope || 'session';
  const body: Record<string, string> = {
    name: scope === 'project' ? 'New shared project thread' : 'New thread',
  };
  if (engine) body.engine = engine;
  if (scope === 'project' && opts.projectId) {
    body.projectId = opts.projectId;
    body.label = 'project_ai';
    body.visibility = 'project';
  } else {
    body.parentSessionId = contextId;
    body.label = 'ai_thread';
    body.visibility = 'private';
  }
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  return res.json();
}

function parseStoredContent(content: unknown): any[] {
  if (Array.isArray(content)) return content;
  if (typeof content !== 'string') return [];
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === 'string') return [{ type: 'text', text: parsed }];
    if (parsed && typeof parsed === 'object') return [parsed];
    return [];
  } catch {
    return [{ type: 'text', text: content }];
  }
}

export async function fetchThreadMessages(sessionId: string): Promise<ChatMessage[]> {
  const res = await fetch(`/api/sessions/${sessionId}/messages`, { headers: authHeaders() });
  if (!res.ok) return [];
  const stored = await res.json();
  return stored.map((m: any) => ({
    id: m.id,
    role: m.role,
    content: normalizeContentBlocks(parseStoredContent(m.content)),
    timestamp: new Date(m.created_at).getTime(),
    updatedAt: m.updated_at ? new Date(m.updated_at).getTime() : undefined,
    completedAt: m.completed_at ? new Date(m.completed_at).getTime() : undefined,
    parentToolUseId: m.parent_tool_use_id,
    durationMs: m.duration_ms || undefined,
    inputTokens: m.input_tokens || undefined,
    outputTokens: m.output_tokens || undefined,
    metadata: m.metadata ?? null,
  }));
}
