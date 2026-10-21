import { parseArtifactFences } from '../../../shared/artifact-fences';
import i18n from '../i18n';
import type { ContentBlock } from '../stores/chat-store';

export function extractThinkingTitle(raw?: string): string | undefined {
  if (!raw) return undefined;

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const firstLine = lines[0];
  if (!firstLine) return undefined;

  const boldTitle = firstLine.match(/^\*\*(.+?)\*\*[：:]?$/);
  if (boldTitle?.[1]) return boldTitle[1].trim();

  const headingTitle = firstLine.match(/^#{1,6}\s+(.+)$/);
  if (headingTitle?.[1]) return headingTitle[1].trim();

  return undefined;
}

function normalizeThinkingBlock(raw: string, explicitTitle?: string): ContentBlock {
  return {
    type: 'thinking',
    thinking: {
      text: raw,
      title: explicitTitle || extractThinkingTitle(raw),
    },
  };
}

/**
 * Extract <thinking> blocks from a raw text string.
 * Handles: leading, mid-text, trailing, multiple, and partial (streaming) thinking blocks.
 */
function extractThinkingFromText(raw: string): ContentBlock[] {
  const result: ContentBlock[] = [];
  // Regex matches all complete <thinking>...</thinking> blocks anywhere in the text
  const pattern = /(<(?:antml_)?thinking>)([\s\S]*?)(<\/(?:antml_)?thinking>)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(raw)) !== null) {
    const before = raw.slice(lastIndex, match.index).trim();
    if (before) result.push({ type: 'text', text: before });
    result.push(normalizeThinkingBlock(match[2]));
    lastIndex = match.index + match[0].length;
  }

  // Remaining text after all complete blocks
  const after = raw.slice(lastIndex);

  // Check if remaining text contains an unclosed opening tag (streaming)
  const openTagMatch = after.match(/^([\s\S]*?)<(?:antml_)?thinking>([\s\S]*)$/);
  if (openTagMatch) {
    const beforeOpen = openTagMatch[1].trim();
    if (beforeOpen) result.push({ type: 'text', text: beforeOpen });
    result.push(normalizeThinkingBlock(openTagMatch[2]));
  } else {
    const trimmed = after.trim();
    if (trimmed) result.push({ type: 'text', text: trimmed });
  }

  // Fallback: no thinking blocks at all → single text block
  if (result.length === 0 && raw.trim()) {
    result.push({ type: 'text', text: raw });
  }

  return result;
}



function parseArtifactAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /(\w+)=(?:"([^"]*)"|'([^']*)'|([^\s]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) attrs[match[1]] = match[2] ?? match[3] ?? match[4] ?? '';
  return attrs;
}

function isOnlyFenceWrapperRemainder(text: string): boolean {
  const trimmed = text.trim();
  return /^```(?:md|markdown)?$/i.test(trimmed) || trimmed === '```';
}

function normalizeTextWithArtifactFallback(raw: string, streaming = false): ContentBlock[] {
  if (!raw.includes('```tower-artifact')) return extractThinkingFromText(raw);

  const result: ContentBlock[] = [];
  let lastIndex = 0;
  for (const match of parseArtifactFences(raw, streaming)) {
    const before = raw.slice(lastIndex, match.index);
    if (before.trim() && !isOnlyFenceWrapperRemainder(before)) result.push(...extractThinkingFromText(before));
    const attrs = parseArtifactAttrs(match.attrs);
    result.push({
      type: 'artifact_markdown',
      path: attrs.path || undefined,
      title: attrs.title || undefined,
      text: match.body,
      status: 'pending',
    });
    lastIndex = match.end;
  }
  const after = raw.slice(lastIndex);
  if (after.trim() && !isOnlyFenceWrapperRemainder(after)) result.push(...extractThinkingFromText(after));
  return result.length > 0 ? result : [{ type: 'text', text: raw }];
}

/**
 * Parse an SDK assistant message into UI-renderable content blocks.
 *
 * SDK assistant messages have:
 *   message.content: Array<{ type: 'text', text } | { type: 'tool_use', id, name, input } | { type: 'thinking', thinking }>
 */
export function parseSDKMessage(sdkMsg: any, streaming = false): ContentBlock[] {
  if (!sdkMsg?.message?.content) return [];

  const blocks: ContentBlock[] = [];

  for (const item of sdkMsg.message.content) {
    if (item.type === 'thinking') {
      const thinkingText = typeof item.thinking === 'string'
        ? item.thinking
        : (item.thinking?.text || item.text || '');
      const thinkingTitle = typeof item.thinking === 'object'
        ? item.thinking?.title
        : item.title;
      blocks.push(normalizeThinkingBlock(thinkingText, thinkingTitle));
    } else if (item.type === 'text') {
      const raw = item.text || '';
      blocks.push(...normalizeTextWithArtifactFallback(raw, streaming));
    } else if (item.type === 'commentary') {
      blocks.push({
        type: 'commentary',
        text: item.visibility === 'progress' && typeof item.text === 'string' ? item.text : '',
        phase: 'commentary',
        visibility: item.visibility === 'progress' ? 'progress' : 'hidden',
      });
    } else if (item.type === 'tool_use') {
      blocks.push({
        type: 'tool_use',
        toolUse: {
          id: item.id,
          name: item.name,
          input: item.input || {},
        },
      });
    } else if (item.type === 'tool_result') {
      // tool results are usually nested — find matching tool_use
      blocks.push({
        type: 'tool_result',
        toolUse: {
          id: item.tool_use_id || '',
          name: '',
          input: {},
          result: typeof item.content === 'string'
            ? item.content
            : JSON.stringify(item.content),
        },
      });
    } else {
      console.warn('[parseSDKMessage] unhandled content block type:', item.type, item);
    }
  }

  return blocks;
}

/**
 * Normalize raw SDK content blocks (from DB) into UI ContentBlock format.
 * Raw SDK: { type: 'tool_use', id, name, input }
 * ContentBlock: { type: 'tool_use', toolUse: { id, name, input } }
 */
export function normalizeContentBlocks(blocks: any[], previousBlocks: ContentBlock[] = [], streaming = false): ContentBlock[] {
  if (!Array.isArray(blocks)) return [];

  const previousToolResults = new Map<string, string>();
  for (const block of previousBlocks) {
    if ((block.type === 'tool_use' || block.type === 'tool_result') && block.toolUse?.id && block.toolUse.result) {
      previousToolResults.set(block.toolUse.id, block.toolUse.result);
    }
  }

  return blocks.flatMap((item) => {
    // Already in ContentBlock format (has toolUse/thinking/agentRun wrapper)
    if (item.type === 'tool_use' && item.toolUse) return item;
    if (item.type === 'agent_run') {
      return {
        type: 'agent_run' as const,
        agentRun: item.agentRun || {
          workerId: item.workerId,
          runId: item.runId,
          backingSessionId: item.backingSessionId,
          workerName: item.workerName,
          workerRole: item.workerRole,
          workerFace: item.workerFace,
          workerTagline: item.workerTagline,
          fromName: item.fromName,
          parentSessionId: item.parentSessionId,
          parentSessionName: item.parentSessionName,
          mode: item.mode,
          status: item.status,
          summary: item.summary,
          detailArtifacts: item.detailArtifacts,
          detailArtifactPaths: Array.isArray(item.detailArtifactPaths) ? item.detailArtifactPaths : undefined,
          detailArtifactSummary: item.detailArtifactSummary,
          readIfNeeded: item.readIfNeeded,
          retrievalHint: item.retrievalHint,
          suggestedNext: item.suggestedNext,
          injectedAt: item.injectedAt,
        },
      };
    }
    if (item.type === 'thinking' && item.thinking?.text) {
      return normalizeThinkingBlock(item.thinking.text, item.thinking.title);
    }
    if (item.type === 'commentary') {
      return {
        type: 'commentary' as const,
        text: item.visibility === 'progress' && typeof item.text === 'string' ? item.text : '',
        phase: 'commentary' as const,
        visibility: item.visibility === 'progress' ? 'progress' as const : 'hidden' as const,
      };
    }
    if (item.type === 'artifact_markdown') {
      return {
        type: 'artifact_markdown' as const,
        text: typeof item.text === 'string' ? item.text : '',
        path: typeof item.path === 'string' ? item.path : undefined,
        portablePath: typeof item.portablePath === 'string' ? item.portablePath : undefined,
        title: typeof item.title === 'string' ? item.title : undefined,
        sha256: typeof item.sha256 === 'string' ? item.sha256 : undefined,
        status: item.status === 'saved' || item.status === 'pending' || item.status === 'skipped' || item.status === 'error' ? item.status : undefined,
        error: typeof item.error === 'string' ? item.error : undefined,
      };
    }
    // Extract artifact-backed Markdown and <thinking> tags from text blocks.
    // Backend normally materializes `tower-artifact` fences before persistence,
    // but this frontend fallback keeps live/legacy messages from rendering raw
    // control fences when a message bypassed that normalization path.
    if (item.type === 'text' && item.text) {
      const extracted = normalizeTextWithArtifactFallback(item.text, streaming);
      // Only expand when a special block was actually found; otherwise return
      // the original text block to preserve streaming identity/reference shape.
      if (extracted.some((b) => b.type === 'thinking' || b.type === 'artifact_markdown')) return extracted;
      return item;
    }

    // Raw SDK format — convert
    if (item.type === 'tool_use') {
      const toolId = item.id || item.toolUse?.id || '';
      return {
        type: 'tool_use' as const,
        toolUse: {
          id: toolId,
          name: item.name || item.toolUse?.name || '',
          input: item.input || item.toolUse?.input || {},
          result: item.result ?? item.toolUse?.result ?? (toolId ? previousToolResults.get(toolId) : undefined),
        },
      };
    }
    if (item.type === 'thinking') {
      const thinkingText = typeof item.thinking === 'string'
        ? item.thinking
        : (item.thinking?.text || item.text || '');
      const thinkingTitle = typeof item.thinking === 'object'
        ? item.thinking?.title
        : item.title;
      return normalizeThinkingBlock(thinkingText, thinkingTitle);
    }
    if (item.type === 'commentary') {
      return {
        type: 'commentary' as const,
        text: item.visibility === 'progress' && typeof item.text === 'string' ? item.text : '',
        phase: 'commentary' as const,
        visibility: item.visibility === 'progress' ? 'progress' as const : 'hidden' as const,
      };
    }
    if (item.type === 'artifact_markdown') {
      return {
        type: 'artifact_markdown' as const,
        text: typeof item.text === 'string' ? item.text : '',
        path: typeof item.path === 'string' ? item.path : undefined,
        portablePath: typeof item.portablePath === 'string' ? item.portablePath : undefined,
        title: typeof item.title === 'string' ? item.title : undefined,
        sha256: typeof item.sha256 === 'string' ? item.sha256 : undefined,
        status: item.status === 'saved' || item.status === 'pending' || item.status === 'skipped' || item.status === 'error' ? item.status : undefined,
        error: typeof item.error === 'string' ? item.error : undefined,
      };
    }
    // Unknown block type — convert to empty text block to prevent React error #31
    // ("Objects are not valid as a React child") if this object gets rendered directly.
    console.warn('[normalizeContentBlocks] unknown content block, converting to text:', item.type, item);
    return { type: 'text' as const, text: typeof item.text === 'string' ? item.text : '' };
  });
}

function canonicalToolName(name: string): string {
  if (normalizedToolName(name) === 'sleep') return 'Sleep';
  const shortName = name.split('.').pop()?.replace(/^functions__/, '') || name;
  return shortName.charAt(0).toUpperCase() + shortName.slice(1);
}

function normalizedToolName(name: string): string {
  const shortName = (name.split('.').pop() || name).replace(/^functions__/, '').toLowerCase();
  if (shortName === 'wait' || /^mcp__wait__wait$/.test(shortName)) return 'sleep';
  if (/^mcp__(?:sleep|session[-_]wait)__sleep$/.test(shortName)) return 'sleep';
  return shortName;
}

export function toToolActivityNoun(phrase: string): string {
  return phrase
    .replace(/하고 있습니다$/, '하기')
    .replace(/고 있습니다$/, '기')
    .replace(/중입니다$/, '중')
    .replace(/입니다$/, '')
    .replace(/ing$/, 'ing');
}

function toolI18nKey(name: string): string {
  return normalizedToolName(name).replace(/[^a-z0-9]+/g, '_');
}

function shellActivityKey(input: Record<string, any>) {
  const shellCommand = typeof input.command === 'string' ? input.command.trim() : '';
  const shellEntrypoint = typeof input.entrypoint === 'string' ? input.entrypoint.trim() : '';
  const shellText = shellCommand || shellEntrypoint;
  if (/\b(npm|pnpm|yarn|bun)\s+(test|run\s+test)|\b(vitest|jest|playwright|pytest|go\s+test|cargo\s+test|make\s+test)\b/i.test(shellText)) return 'test';
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?(build|typecheck|lint)|\b(tsc|eslint)\b/i.test(shellText)) return 'verify';
  return 'runCode';
}

function toolActivityKey(name: string, input: Record<string, any> = {}) {
  const kind = normalizedToolName(name);
  if (kind === 'read') return 'read';
  if (kind === 'grep' || kind === 'glob' || kind === 'find') return 'search';
  if (kind === 'write') return 'write';
  if (kind === 'edit') return 'edit';
  if (kind === 'bash' || kind === 'project_shell' || kind === 'mcp__sandbox__run') return shellActivityKey(input);
  if (kind === 'todowrite') return 'todo';
  if (kind === 'sleep') return 'sleep';
  if (kind === 'websearch') return 'webSearch';
  if (kind === 'webfetch') return 'webFetch';
  if (kind === 'pdf_view' || kind === 'pdf_read' || kind === 'pdf_render') return 'pdf';
  if (kind === 'pdf_export') return 'pdfExport';
  if (kind === 'excel_read' || kind === 'excel_query' || kind === 'excel_diff') return 'excel';
  if (kind === 'excel_write') return 'excelWrite';
  if (kind === 'publish_site') return 'publish';
  if (kind === 'present_file') return 'presentFile';
  if (kind === 'askuserquestion') return 'askUser';
  if (kind === 'service_start') return 'serviceStart';
  if (kind === 'service_logs') return 'serviceLogs';
  if (kind === 'service_stop') return 'serviceStop';
  if (kind === 'agent_session_run_once' || kind === 'persistent_agent_create' || kind === 'persistent_agent_send') return 'agent';
  if (kind.startsWith('mcp__agent_worker__')) return 'agent';
  return 'default';
}

/** Get a human-friendly label for a tool name */
export function getToolLabel(name: string): string {
  const fallbackLabels: Record<string, string> = {
    sleep: 'Wait',
    bash: 'Run command',
    read: 'Read file',
    write: 'Create file',
    edit: 'Edit file',
    glob: 'Search files',
    grep: 'Search content',
    task: 'Sub-task',
    websearch: 'Web search',
    webfetch: 'Fetch page',
    askuserquestion: 'Ask user',
    credential_vault_input: 'Secure credential input',
    enterplanmode: 'Plan mode',
    exitplanmode: 'Plan complete',
    todowrite: 'Work steps',
    present_file: 'Present file',
    project_shell: 'Run in project',
    service_start: 'Start service',
    service_logs: 'Read logs',
    service_stop: 'Stop service',
    pdf_view: 'View PDF',
    pdf_read: 'Extract PDF tables',
    pdf_export: 'Export PDF',
    pdf_render: 'Render PDF',
    excel_read: 'Read spreadsheet',
    excel_query: 'Analyze spreadsheet',
    excel_write: 'Create spreadsheet',
    excel_diff: 'Compare spreadsheets',
    publish_site: 'Publish site',
    agent_session_run_once: 'Agent Session',
    persistent_agent_create: 'Create agent',
    persistent_agent_send: 'Send to agent',
  };
  const key = toolI18nKey(name);
  return i18n.t(`chat:toolLabels.${key}`, { defaultValue: fallbackLabels[key] || name });
}

/** Get the live, user-facing activity phrase for a tool use. */
export function getToolActivityLabel(name: string, input: Record<string, any> = {}): string {
  const key = toolActivityKey(name, input);
  return i18n.t(`chat:toolActivity.${key}`, { defaultValue: i18n.t('chat:toolActivity.default') });
}

/** Get the compact noun form for grouped tool activity counts. */
export function getToolActivityNoun(name: string, input: Record<string, any> = {}): string {
  const key = toolActivityKey(name, input);
  return i18n.t(`chat:toolActivityNoun.${key}`, { defaultValue: toToolActivityNoun(getToolActivityLabel(name, input)) });
}

export function getThinkingLabel(title?: string, text?: string): string {
  const raw = title || extractThinkingTitle(text);
  return raw === 'thinking' || !raw ? i18n.t('chat:thinking') : raw;
}

/** Requested duration only: without a measured tool start time, this is not a countdown. */
export function getSleepDurationLabel(input: Record<string, any>): string | undefined {
  const seconds = input.durationSeconds;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return undefined;
  return i18n.t('chat:toolSummary.sleepDuration', {
    seconds,
    defaultValue: '예상 대기 시간 {{seconds}}초',
  });
}

/** Get a summary string for a tool use */
export function getToolSummary(name: string, input: Record<string, any>): string {
  // Normalize: SDK may send "bash" or "Bash"
  const n = canonicalToolName(name);
  switch (n) {
    case 'Sleep': {
      const duration = getSleepDurationLabel(input);
      const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
      return [duration || getToolLabel(name), reason && truncate(reason, 60)].filter(Boolean).join(' · ');
    }
    case 'Bash':
      return input.command ? `$ ${truncate(input.command, 60)}` : 'Bash';
    case 'Read': {
      const filePath = input.file_path || input.path;
      return filePath ? `📄 ${basename(filePath)}` : getToolLabel(name);
    }
    case 'Write': {
      const filePath = input.file_path || input.path;
      return filePath ? `✏️ ${basename(filePath)}` : getToolLabel(name);
    }
    case 'Edit': {
      const filePath = input.file_path || input.path;
      return filePath ? `📝 ${basename(filePath)}` : getToolLabel(name);
    }
    case 'Glob':
      return input.pattern ? `🔍 ${input.pattern}` : getToolLabel(name);
    case 'Grep':
      return input.pattern ? `🔎 "${truncate(input.pattern, 40)}"` : getToolLabel(name);
    case 'WebSearch':
      return input.query ? `🌐 ${truncate(input.query, 50)}` : getToolLabel(name);
    case 'AskUserQuestion': {
      const q = input.questions?.[0]?.question;
      return q ? truncate(q, 50) : getToolLabel(name);
    }
    case 'credential_vault_input':
    case 'Credential_vault_input':
      return input.displayName ? `🔐 ${truncate(input.displayName, 50)}` : getToolLabel(name);
    case 'Task':
      return input.description ? truncate(input.description, 50) : getToolLabel(name);
    case 'EnterPlanMode':
      return getToolLabel(name);
    case 'ExitPlanMode':
      return getToolLabel(name);
    case 'present_file': {
      const filePath = input.path;
      return filePath ? `📎 ${basename(filePath)}` : getToolLabel(name);
    }
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos)
        ? (input.todos as Array<{ content: string; status: string }>)
        : undefined;
      if (!todos?.length) return getToolLabel(name);
      const done = todos.filter(t => t.status === 'completed').length;
      const inProg = todos.filter(t => t.status === 'in_progress').length;
      const total = todos.length;
      if (done === total) return i18n.t('chat:toolSummary.workStepsComplete', { total });
      if (inProg > 0) return i18n.t('chat:toolSummary.workStepsProgress', { completed: done, total });
      return i18n.t('chat:toolSummary.workStepsPlanned', { total });
    }
    default: {
      const normalized = name.replace(/^mcp__agent-worker__/, '');
      if (normalized === 'agent_session_run_once') return input.name ? `🤖 ${truncate(input.name, 50)}` : getToolLabel(name);
      if (normalized === 'persistent_agent_create') return input.name ? `🤖 ${truncate(input.name, 50)}` : getToolLabel(name);
      if (normalized === 'persistent_agent_send') return input.worker ? `🤖 ${truncate(input.worker, 50)}` : getToolLabel(name);
      return name;
    }
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

function basename(p: string): string {
  return p.split('/').pop() || p;
}
