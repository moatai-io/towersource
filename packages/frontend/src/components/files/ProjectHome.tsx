import React, { useCallback, useEffect, useMemo, useState } from 'react';
import i18n from '../../i18n';
import type { Project } from '../../stores/project-store';
import { useFileStore } from '../../stores/file-store';
import { useProjectStore } from '../../stores/project-store';
import { useSessionStore } from '../../stores/session-store';
import { useSettingsStore } from '../../stores/settings-store';
import { MarkdownReadSurface } from './MarkdownReadSurface';
import { AgentHomeOverview } from '../agents/AgentHomeOverview';
import { FilesWorkspace } from './FilesWorkspace';
import { FileExchangeDropTarget } from '../../features/file-exchange/FileExchangeDropTarget';
import { WorkspaceKnowledgeGraph } from './WorkspaceKnowledgeGraph';
import { toastError, toastSuccess } from '../../utils/toast';
import { AGENT_CHARACTERS, AgentCharacterAvatar, agentFaceImageUrl, characterFace } from '../../features/agent-profile/characters';
import { AgentIdentityAvatar } from '../../features/agent-profile/AgentIdentityAvatar';
import { getAgentWorkspaceLocation, rememberAgentWorkspaceLocation } from '../../features/agent-workspace/navigation-state';

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const projectSessionsLoaded = new Set<string>();
const projectSessionsLoading = new Set<string>();

function compactPath(path?: string | null): string {
  return path ? path.replace(/^\/home\/[^/]+/, '~') : '—';
}

interface SkillSummary {
  id?: string;
  name: string;
  description?: string;
  scope?: string;
  source?: string;
}

interface AgentSummary {
  id: string;
  displayName?: string;
  role?: string;
  visibility?: string;
  worker?: { status?: string; backing_session_id?: string | null } | null;
  latestRun?: { id?: string; status?: string; result_summary?: string | null; artifact_paths?: unknown[] | null; error?: string | null } | null;
  stateCard?: { goal?: string; current_focus?: string; next_action?: string; blockers?: unknown[] } | null;
}

interface CommandSummary {
  name: string;
  canonical?: string;
  description?: string;
  source?: string;
  scope?: string;
  kind?: string;
}

interface Segment {
  start: string;
  end: string;
  kind: 'work' | 'active' | 'done';
  snapshotCount: number;
}

interface WorkSessionSummary {
  id: string;
  name: string;
  owner: string;
  lastAt: string;
  snapshotCount: number;
  todoTotal: number;
  todoDone: number;
  todoLeft: number;
  runTitles?: string[];
}

interface WorkstreamSummary {
  id: string;
  title: string;
  status: 'active' | 'waiting' | 'resolved';
  todoTotal: number;
  todoDone: number;
  todoLeft: number;
  sessionCount: number;
  lastAt: string;
  runTitles?: string[];
  outcomes?: string[];
  backlog?: Array<{ title: string }>;
  questions?: Array<{ title: string }>;
  sessions?: WorkSessionSummary[];
  segments?: Segment[];
}

interface WorkTimelineProjectGroup {
  id: string | null;
  name: string;
  challengeCount: number;
  todoLeft: number;
  challenges: WorkstreamSummary[];
}

interface WorkTimelineResponse {
  projects?: WorkTimelineProjectGroup[];
  totals?: {
    challenges: number;
    todoLeft: number;
    snapshots: number;
  };
}

interface NoteItem {
  path: string;
  absolutePath: string;
  displayTitle: string;
  title: string;
  kind: string;
  inferredType: string;
  pathClass: string;
  score: number;
  modified?: string;
  size?: number;
}

interface NotesIndexResponse {
  summary?: { totalItems: number; currentItems: number };
  folders?: Array<{ folder: string; label: string; items: NoteItem[] }>;
}

const WORKSTREAM_RANGE_OPTIONS = [
  { days: 3, label: '3일' },
  { days: 7, label: '7일' },
  { days: 14, label: '14일' },
  { days: 30, label: '30일' },
];

interface WikiPageLink {
  path: string;
  title: string;
  description: string;
}

interface WikiHomeModel {
  title: string;
  intro: string;
  pages: WikiPageLink[];
  stance: string[];
}

function selectProjectWorkstreamGroup(data: WorkTimelineResponse | null | undefined, project: Project): WorkTimelineProjectGroup | null {
  const groups = data?.projects || [];
  const exactId = groups.find((group) => group.id === project.id);
  if (exactId) return exactId;
  const exactName = groups.find((group) => group.name === project.name);
  if (exactName) return exactName;
  return groups.length === 1 ? groups[0] : null;
}

function fileText(key: string, options?: Record<string, unknown>): string {
  return i18n.t(key, { ns: 'files', ...options });
}

function formatRelativeTime(value: string): string {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return value;
  const diffMs = Date.now() - time;
  const minutes = Math.max(0, Math.floor(diffMs / 60_000));
  if (minutes < 1) return fileText('projectHome.relativeTime.justNow');
  if (minutes < 60) return fileText('projectHome.relativeTime.minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return fileText('projectHome.relativeTime.hoursAgo', { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return fileText('projectHome.relativeTime.daysAgo', { count: days });
  return new Date(value).toLocaleDateString(i18n.resolvedLanguage || i18n.language, { month: 'short', day: 'numeric' });
}

function workstreamStatusLabel(status: WorkstreamSummary['status']): string {
  return fileText(`projectHome.workstreamStatus.${status === 'resolved' ? 'resolved' : status === 'waiting' ? 'waiting' : 'active'}`);
}

function workstreamStatusClass(status: WorkstreamSummary['status']): string {
  if (status === 'resolved') return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300';
  if (status === 'waiting') return 'border-red-500/25 bg-red-500/10 text-red-300';
  return 'border-amber-500/25 bg-amber-500/10 text-amber-300';
}

function formatBytes(bytes?: number): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i++) {
    value /= 1024;
    unit = units[i];
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

function formatModified(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(i18n.resolvedLanguage || i18n.language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function segmentClass(kind: Segment['kind']): string {
  if (kind === 'done') return 'bg-emerald-400/35 border-emerald-300/45';
  if (kind === 'active') return 'bg-amber-300/40 border-amber-200/55';
  return 'bg-primary-400/40 border-primary-300/55';
}

function openSession(sessionId: string) {
  window.dispatchEvent(new CustomEvent('kanban-select-session', { detail: { sessionId } }));
}

function segmentStyle(segment: Segment, start: string, end: string): React.CSSProperties {
  const min = new Date(start).getTime();
  const max = new Date(end).getTime();
  const span = Math.max(max - min, 1);
  const a = new Date(segment.start).getTime();
  const b = new Date(segment.end).getTime();
  const left = Math.max(0, Math.min(100, ((a - min) / span) * 100));
  const right = Math.max(left + 1.8, Math.min(100, ((b - min) / span) * 100));
  return { left: `${left}%`, width: `${Math.max(2.4, right - left)}%` };
}

function makeMarkdownPreview(content: string, maxLines = 28): string {
  const lines = content.split('\n');
  const preview = lines.slice(0, maxLines).join('\n').trim();
  return preview || content.trim();
}

function resolveWikiHref(rootPath: string, href: string): string {
  const cleanHref = href.split('#')[0].split('?')[0];
  if (!cleanHref) return rootPath ? `${rootPath}/.wiki/index.md` : href;
  if (cleanHref.startsWith('/')) return cleanHref;
  if (cleanHref.startsWith('.wiki/')) return rootPath ? `${rootPath}/${cleanHref}` : cleanHref;
  if (cleanHref.startsWith('pages/')) return rootPath ? `${rootPath}/.wiki/${cleanHref}` : cleanHref;
  if (cleanHref.startsWith('./')) return rootPath ? `${rootPath}/.wiki/pages/${cleanHref.slice(2)}` : cleanHref;
  if (cleanHref.startsWith('../')) return rootPath ? `${rootPath}/.wiki/${cleanHref.replace(/^\.\.\//, '')}` : cleanHref;
  return rootPath ? `${rootPath}/.wiki/${cleanHref}` : cleanHref;
}

function parseWikiHome(content: string): WikiHomeModel {
  const lines = content.split('\n');
  const title = lines.find((line) => line.startsWith('# '))?.replace(/^#\s+/, '').trim() || 'Project Wiki';
  const intro = lines
    .slice(1)
    .find((line) => line.trim() && !line.startsWith('#') && !line.startsWith('- '))
    ?.trim() || '';
  const pages: WikiPageLink[] = [];
  const stance: string[] = [];
  let section = '';

  for (const line of lines) {
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      section = heading[1].trim().toLowerCase();
      continue;
    }
    const linkedBullet = line.match(/^-\s+\[([^\]]+)\]\(([^)]+)\)\s*(?:[—-]\s*)?(.*)$/);
    if (linkedBullet && section.includes('page')) {
      pages.push({ path: linkedBullet[2].trim(), title: linkedBullet[1].trim(), description: linkedBullet[3]?.trim() || '' });
      continue;
    }
    const codePathBullet = line.match(/^-\s+`([^`]+)`\s*(?:[—-]\s*)?(.*)$/);
    if (codePathBullet && section.includes('page')) {
      pages.push({ path: codePathBullet[1], title: codePathBullet[1].replace(/^pages\//, '').replace(/\.md$/, ''), description: codePathBullet[2]?.trim() || '' });
      continue;
    }
    if (line.startsWith('- ') && (section.includes('stance') || section.includes('current'))) {
      stance.push(line.replace(/^-\s+/, '').trim());
    }
  }

  return { title, intro, pages, stance };
}

interface ProjectHomeProps {
  project: Project | null;
  onOpenFiles: () => void;
  onOpenFile: (path: string) => void;
}

type ProjectHomeTab = 'home' | 'graph' | 'files' | 'work';

function projectHomeTabStorageKey(projectId?: string | null): string {
  return `tower:project-home:${projectId || 'unknown'}:tab`;
}

function loadProjectHomeTab(projectId?: string | null): ProjectHomeTab {
  if (projectId) {
    const requestedLocation = getAgentWorkspaceLocation(projectId);
    if (requestedLocation === 'files') return 'files';
    if (requestedLocation === 'work') return 'work';
    if (requestedLocation === 'home') return 'home';
  }
  try {
    const saved = sessionStorage.getItem(projectHomeTabStorageKey(projectId));
    return saved === 'graph' || saved === 'files' || saved === 'work' ? saved : 'home';
  } catch {
    return 'home';
  }
}

export function ProjectHome({ project, onOpenFiles, onOpenFile }: ProjectHomeProps) {
  const [homeTab, setHomeTab] = useState<ProjectHomeTab>(() => loadProjectHomeTab(project?.id));
  const [revealFilePath, setRevealFilePath] = useState<string | null>(null);
  const rootPath = project?.rootPath || '';
  const homeTabClass = (active: boolean) => `pointer-events-auto min-h-11 touch-manipulation rounded-lg px-3 py-2 text-xs font-bold transition-colors ${active ? 'tone-accent tone-action' : 'text-surface-400 hover:bg-surface-800 hover:text-surface-100'}`;
  const openSkillsBrowser = useSettingsStore((s) => s.setSkillsBrowserOpen);
  const openAgentsPanel = useSettingsStore((s) => s.setAgentsPanelOpen);
  const setCapabilityProjectId = useSettingsStore((s) => s.setCapabilityProjectId);
  const sessions = useSessionStore((s) => s.sessions);
  const mergeSessions = useSessionStore((s) => s.mergeSessions);
  const [wikiContent, setWikiContent] = useState('');
  const [wikiLoading, setWikiLoading] = useState(false);
  const [wikiMissing, setWikiMissing] = useState(false);
  const [instructionsContent, setInstructionsContent] = useState('');
  const [instructionsLoading, setInstructionsLoading] = useState(false);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [commands, setCommands] = useState<CommandSummary[]>([]);
  const [capabilitiesLoading, setCapabilitiesLoading] = useState(false);
  const [workstreams, setWorkstreams] = useState<WorkstreamSummary[]>([]);
  const [workstreamTotals, setWorkstreamTotals] = useState({ challenges: 0, todoLeft: 0, snapshots: 0 });
  const [workstreamsLoading, setWorkstreamsLoading] = useState(false);
  const [agentHome, setAgentHome] = useState<any>(null);
  const [editingTeammate, setEditingTeammate] = useState(false);
  const [teammateDraft, setTeammateDraft] = useState({ displayName: '', role: '', tagline: '', face: '', disabledSkills: [] as string[] });
  const [teammateSaving, setTeammateSaving] = useState(false);
  const [characterPrompt, setCharacterPrompt] = useState('');
  const [characterGenerating, setCharacterGenerating] = useState(false);
  const [characterGeneratorOpen, setCharacterGeneratorOpen] = useState(false);
  const [workstreamRangeDays, setWorkstreamRangeDays] = useState(14);
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesError, setNotesError] = useState('');

  useEffect(() => {
    setHomeTab(loadProjectHomeTab(project?.id));
  }, [project?.id]);

  useEffect(() => {
    if (!project?.id) return;
    try { sessionStorage.setItem(projectHomeTabStorageKey(project.id), homeTab); } catch { /* storage unavailable */ }
  }, [homeTab, project?.id]);

  useEffect(() => {
    const projectId = project?.id;
    if (!projectId || projectSessionsLoaded.has(projectId) || projectSessionsLoading.has(projectId)) return;
    projectSessionsLoading.add(projectId);
    const params = new URLSearchParams({ projectId });
    void fetch(`/api/sessions?${params.toString()}`, { headers: authHeaders() })
      .then(async (res) => {
        if (!res.ok) throw new Error(`project session lazy load failed: ${res.status}`);
        const data = await res.json().catch(() => []);
        if (Array.isArray(data)) mergeSessions(data);
        projectSessionsLoaded.add(projectId);
      })
      .catch((error) => {
        console.warn('[project-home] failed to lazy-load project sessions:', error);
      })
      .finally(() => {
        projectSessionsLoading.delete(projectId);
      });
  }, [mergeSessions, project?.id]);

  const wikiPath = rootPath ? `${rootPath}/.wiki/index.md` : '';
  const instructionsPath = rootPath ? `${rootPath}/AGENTS.md` : '';

  const loadTextFile = useCallback(async (path: string): Promise<string | null> => {
    if (!path) return null;
    const res = await fetch(`/api/files/read?path=${encodeURIComponent(path)}`, { headers: authHeaders() });
    if (res.status === 404) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return null;
    return typeof data.content === 'string' ? data.content : '';
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!instructionsPath) return;
    setInstructionsLoading(true);
    void loadTextFile(instructionsPath)
      .then((content) => {
        if (cancelled) return;
        setInstructionsContent(content || '');
      })
      .catch(() => {
        if (cancelled) return;
        setInstructionsContent('');
      })
      .finally(() => {
        if (!cancelled) setInstructionsLoading(false);
      });
    return () => { cancelled = true; };
  }, [instructionsPath, loadTextFile]);

  useEffect(() => {
    let cancelled = false;
    if (!wikiPath) return;
    setWikiLoading(true);
    setWikiMissing(false);
    void loadTextFile(wikiPath)
      .then((content) => {
        if (cancelled) return;
        setWikiContent(content || '');
        setWikiMissing(content == null || !content.trim());
      })
      .catch(() => {
        if (cancelled) return;
        setWikiContent('');
        setWikiMissing(true);
      })
      .finally(() => {
        if (!cancelled) setWikiLoading(false);
      });
    return () => { cancelled = true; };
  }, [loadTextFile, wikiPath]);

  useEffect(() => {
    let cancelled = false;
    if (!project?.id) return;
    const headers = authHeaders();
    const fetchJson = async <T,>(url: string, fallback: T): Promise<T> => {
      const res = await fetch(url, { headers });
      if (!res.ok) return fallback;
      return await res.json().catch(() => fallback);
    };

    setCapabilitiesLoading(true);
    const projectParam = encodeURIComponent(project.id);
    const cwdParam = rootPath ? `&cwd=${encodeURIComponent(rootPath)}` : '';
    void Promise.all([
      fetchJson<SkillSummary[]>(`/api/skills?projectId=${projectParam}`, []),
      fetchJson<AgentSummary[]>(`/api/agents?projectId=${projectParam}`, []),
      fetchJson<CommandSummary[]>(`/api/commands?projectId=${projectParam}${cwdParam}`, []),
    ])
      .then(([nextSkills, nextAgents, nextCommands]) => {
        if (cancelled) return;
        setSkills(Array.isArray(nextSkills) ? nextSkills : []);
        setAgents(Array.isArray(nextAgents) ? nextAgents : []);
        setCommands(Array.isArray(nextCommands) ? nextCommands : []);
      })
      .catch(() => {
        if (cancelled) return;
        setSkills([]);
        setAgents([]);
        setCommands([]);
      })
      .finally(() => {
        if (!cancelled) setCapabilitiesLoading(false);
      });

    return () => { cancelled = true; };
  }, [project?.id, rootPath]);

  useEffect(() => {
    let cancelled = false;
    if (!rootPath) return;
    const params = new URLSearchParams({ path: rootPath, mode: 'current', maxFiles: '2500', maxDepth: '8' });
    setNotesLoading(true);
    setNotesError('');
    void fetch(`/api/files/notes-index?${params.toString()}`, { headers: authHeaders() })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `노트 목록을 불러오지 못했습니다 (${res.status})`);
        return data as NotesIndexResponse;
      })
      .then((data) => {
        if (cancelled) return;
        const items = (data.folders || []).flatMap((folder) => folder.items || []);
        const nextNotes = items.sort((a, b) => (b.score || 0) - (a.score || 0) || (new Date(b.modified || 0).getTime() - new Date(a.modified || 0).getTime())).slice(0, 12);
        setNotes(nextNotes);
      })
      .catch((err) => {
        if (cancelled) return;
        setNotes([]);
        setNotesError(err instanceof Error ? err.message : '노트 목록을 불러오지 못했습니다');
      })
      .finally(() => {
        if (!cancelled) setNotesLoading(false);
      });
    return () => { cancelled = true; };
  }, [rootPath]);

  useEffect(() => {
    let cancelled = false;
    if (!project?.id) return;
    void fetch(`/api/projects/${project.id}/agent-home`, { headers: authHeaders() }).then(async res => res.ok ? res.json() : null).then(data => { if (!cancelled) setAgentHome(data); }).catch(() => { if (!cancelled) setAgentHome(null); });
    return () => { cancelled = true; };
  }, [project?.id]);

  useEffect(() => {
    let cancelled = false;
    if (!project?.id) return;
    const params = new URLSearchParams({
      rangeHours: String(24 * workstreamRangeDays),
      bucketHours: workstreamRangeDays <= 3 ? '6' : '24',
      limit: '8',
      projectId: project.id,
    });
    setWorkstreamsLoading(true);
    void fetch(`/api/work/challenge-timeline?${params.toString()}`, { headers: authHeaders() })
      .then(async (res) => (res.ok ? await res.json() as WorkTimelineResponse : null))
      .then((data) => {
        if (cancelled) return;
        const projectGroup = selectProjectWorkstreamGroup(data, project);
        const challenges = projectGroup?.challenges || [];
        setWorkstreams(challenges);
        setWorkstreamTotals({
          challenges: projectGroup?.challengeCount ?? 0,
          todoLeft: projectGroup?.todoLeft ?? 0,
          snapshots: challenges.reduce(
            (sum: number, item: WorkstreamSummary) => sum + (item.sessions || []).reduce(
              (sessionSum: number, session: WorkSessionSummary) => sessionSum + (session.snapshotCount || 0),
              0,
            ),
            0,
          ),
        });
      })
      .catch(() => {
        if (cancelled) return;
        setWorkstreams([]);
        setWorkstreamTotals({ challenges: 0, todoLeft: 0, snapshots: 0 });
      })
      .finally(() => {
        if (!cancelled) setWorkstreamsLoading(false);
      });
    return () => { cancelled = true; };
  }, [project, workstreamRangeDays]);

  const openInstructions = useCallback(async () => {
    if (!instructionsPath) return;
    setInstructionsOpen(true);
    setInstructionsLoading(true);
    try {
      const content = await loadTextFile(instructionsPath);
      setInstructionsContent(content || '');
    } finally {
      setInstructionsLoading(false);
    }
  }, [instructionsPath, loadTextFile]);

  const markdownComponents = useMemo(() => ({
    a({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
      if (!href) return <a {...props}>{children}</a>;
      if (/^https?:\/\//.test(href)) return <a href={href} target="_blank" rel="noreferrer" {...props}>{children}</a>;
      const resolved = resolveWikiHref(rootPath, href);
      return (
        <a
          href={href}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onOpenFile(resolved);
          }}
          className="cursor-pointer text-primary-300 underline decoration-primary-500/50 underline-offset-4 hover:text-primary-300"
        >
          {children}
        </a>
      );
    },
  }), [onOpenFile, rootPath]);

  const openProjectSkills = useCallback(() => {
    setCapabilityProjectId(project?.id || null);
    openSkillsBrowser(true);
  }, [openSkillsBrowser, project?.id, setCapabilityProjectId]);

  const openProjectAgents = useCallback(() => {
    setCapabilityProjectId(project?.id || null);
    openAgentsPanel(true);
  }, [openAgentsPanel, project?.id, setCapabilityProjectId]);

  const openProjectFiles = useCallback(() => {
    setCapabilityProjectId(project?.id || null);
    onOpenFiles();
  }, [onOpenFiles, project?.id, setCapabilityProjectId]);

  useEffect(() => {
    const revealFile = (event: Event) => {
      const detail = (event as CustomEvent<{ path?: string; projectId?: string }>).detail;
      if (!detail?.path || (detail.projectId && detail.projectId !== project?.id)) return;
      setRevealFilePath(detail.path);
      setHomeTab('files');
    };
    window.addEventListener('tower-reveal-file-in-agent-home', revealFile as EventListener);
    return () => window.removeEventListener('tower-reveal-file-in-agent-home', revealFile as EventListener);
  }, [project?.id]);

  const startPrimaryConversation = useCallback(() => {
    const candidates = sessions.filter((session) => session.projectId === project?.id && session.label !== 'agent');
    const latest = candidates.sort((a, b) => new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime())[0];
    if (latest?.id) openSession(latest.id);
    else useSessionStore.getState().setActiveView('chat');
  }, [project?.id, sessions]);
  const editTeammate = useCallback(() => {
    const disabledSkills = Array.isArray(project?.agent?.toolPolicy?.disabledSkills) ? project.agent.toolPolicy.disabledSkills : [];
    setTeammateDraft({
      displayName: project?.agent?.displayName || project?.name || '',
      role: project?.agent?.role || '',
      tagline: project?.agent?.tagline || '',
      face: project?.agent?.face || '',
      disabledSkills,
    });
    setCharacterPrompt('');
    setCharacterGeneratorOpen(false);
    setEditingTeammate(true);
  }, [project]);
  const saveTeammate = useCallback(async () => {
    if (!project?.id || !teammateDraft.displayName.trim()) return;
    setTeammateSaving(true);
    try {
      const res = await fetch(`/api/projects/${project.id}/agent-profile`, { method: 'PATCH', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(teammateDraft) });
      const updatedProject = await res.json().catch(() => null);
      if (!res.ok || !updatedProject?.id) throw new Error(updatedProject?.error || '팀원을 수정하지 못했습니다.');
      useProjectStore.getState().updateProject(updatedProject.id, updatedProject);
      setEditingTeammate(false);
      toastSuccess('팀원 설정을 저장했습니다.');
    } catch (error) {
      toastError(error instanceof Error ? error.message : '팀원을 수정하지 못했습니다.');
    } finally {
      setTeammateSaving(false);
    }
  }, [project?.id, teammateDraft]);

  const generateCharacter = useCallback(async () => {
    if (!project?.id || !characterPrompt.trim()) return;
    setCharacterGenerating(true);
    try {
      const res = await fetch('/api/agent-characters/generate', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: characterPrompt, projectId: project.id }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '캐릭터를 생성하지 못했습니다.');
      setTeammateDraft((current) => ({ ...current, face: data.face }));
    } catch (error) { toastError(error instanceof Error ? error.message : '캐릭터를 생성하지 못했습니다.'); }
    finally { setCharacterGenerating(false); }
  }, [characterPrompt, project?.id]);

  const startNewConversation = useCallback(() => {
    if (!project?.id) return;
    window.dispatchEvent(new CustomEvent('tower-new-project-conversation', { detail: { projectId: project.id } }));
  }, [project?.id]);

  const openWork = useCallback((workstreamKey?: string) => {
    useSessionStore.getState().setActiveView('work');
    window.requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('tower-open-project-work', { detail: { projectId: project?.id, workstreamKey, rangeHours: 24 * workstreamRangeDays } })));
  }, [project?.id, workstreamRangeDays]);

  const projectSessions = useMemo(() => sessions.filter((session) => session.projectId === project?.id && session.label !== 'agent').sort((a, b) => new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime()), [project?.id, sessions]);
  const skillCommands = useMemo(() => commands.filter((command) => command.kind === 'skill' || command.source === 'skills'), [commands]);
  const visibleWorkstreams = useMemo(() => workstreams.slice(0, 20), [workstreams]);
  const wikiHome = useMemo(() => parseWikiHome(wikiContent), [wikiContent]);
  const instructionsPreview = useMemo(() => makeMarkdownPreview(instructionsContent, 28), [instructionsContent]);
  const instructionsHasMore = instructionsContent.trim().split('\n').length > instructionsPreview.split('\n').length;
  const timelineStart = useMemo(() => {
    const times = workstreams.flatMap((w) => (w.segments || []).map((s) => new Date(s.start).getTime())).filter(Number.isFinite);
    return times.length ? new Date(Math.min(...times)).toISOString() : '';
  }, [workstreams]);
  const timelineEnd = useMemo(() => {
    const times = workstreams.flatMap((w) => (w.segments || []).map((s) => new Date(s.end).getTime())).filter(Number.isFinite);
    return times.length ? new Date(Math.max(...times)).toISOString() : '';
  }, [workstreams]);
  if (!project) {
    return (
      <div className="relative z-10 flex h-full flex-col items-center justify-center bg-surface-950 p-10 text-center">
        <div className="mb-3 text-5xl">🏠</div>
        <h2 className="text-xl font-semibold text-gray-100">열 수 있는 프로젝트가 없습니다</h2>
        <p className="mt-2 max-w-md text-sm text-surface-500">프로젝트가 생기면 홈에서 위키, 지침, 파일함을 한 번에 볼 수 있습니다.</p>
      </div>
    );
  }

  const projectMemberCount = (project as typeof project & { memberCount?: number }).memberCount;

  return (
    <div className="relative z-10 h-full overflow-auto bg-surface-950 text-gray-100">
      <header className="pointer-events-auto sticky top-0 z-30 border-b border-surface-800 bg-surface-950 px-3 py-2 shadow-sm sm:px-5 sm:py-2.5 lg:px-8">
        <div className="flex min-h-9 w-full flex-wrap items-center gap-x-3 gap-y-1 sm:flex-nowrap sm:gap-4">
          <div className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold text-surface-200 sm:flex-initial">
            <AgentIdentityAvatar project={project} className="h-7 w-7 shrink-0 rounded-lg border border-surface-700/60" />
            <span className="truncate">{project.agent?.displayName || project.name}</span>
          </div>
          <nav className="relative z-10 order-3 flex w-full shrink-0 items-center gap-1 sm:order-none sm:w-auto" aria-label="AI 팀원 홈 보기">
            <button type="button" onClick={() => { setHomeTab('home'); if (project?.id) rememberAgentWorkspaceLocation(project.id, 'home'); }} className={homeTabClass(homeTab === 'home')}>홈</button>
            <button type="button" onClick={() => { setHomeTab('files'); if (project?.id) rememberAgentWorkspaceLocation(project.id, 'files'); }} className={homeTabClass(homeTab === 'files')}>전체 파일</button>
            <button type="button" onClick={() => setHomeTab('graph')} className={homeTabClass(homeTab === 'graph')}>그래프</button>
          </nav>
          <div className="ml-auto hidden max-w-[35%] truncate font-mono text-[11px] text-surface-600 sm:block" title={rootPath}>{compactPath(rootPath)}</div>
        </div>
      </header>
      {homeTab === 'files' ? (
        <FileExchangeDropTarget destination={{ scope: 'project', projectId: project.id, relativeDirectory: 'uploads' }} label={`${project.agent?.displayName || project.name} 작업공간에 복사`} className="h-[calc(100vh-58px)] min-h-[560px]"><FilesWorkspace embedded initialProjectId={project.id} revealPath={revealFilePath} onRevealComplete={() => setRevealFilePath(null)} onFileClick={onOpenFile} /></FileExchangeDropTarget>
      ) : homeTab === 'graph' ? (
        <div className="h-[calc(100vh-58px)] min-h-[560px]"><WorkspaceKnowledgeGraph projectId={project.id} rootPath={rootPath} onOpenFile={onOpenFile} onOpenSession={openSession} /></div>
      ) : homeTab === 'work' ? (
        <div className="mx-auto w-full max-w-6xl px-3 py-3 sm:px-5 sm:py-4 lg:px-8"><div className="mb-3 flex items-center justify-between"><div><div className="text-[11px] font-bold uppercase tracking-[.16em] text-surface-500">Workstreams</div><h1 className="mt-1 text-xl font-bold text-surface-100">전체 진행 업무</h1></div><button onClick={() => setHomeTab('home')} className="rounded-lg border border-surface-700 px-3 py-1.5 text-xs font-semibold text-surface-300">홈으로</button></div><div className="space-y-3">{workstreams.map(item=><section key={item.id} className="rounded-2xl border border-surface-800 bg-surface-900/70 p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="truncate text-sm font-bold text-surface-200">{item.title}</h2><p className="mt-1 text-[11px] text-surface-600">{item.status==='resolved'?'완료한 업무':'진행한 업무'} · {formatRelativeTime(item.lastAt)}</p></div><span className="text-xs font-semibold tabular-nums text-surface-400">{item.todoTotal>0?`${item.todoDone}/${item.todoTotal}`:item.status==='resolved'?'완료':item.status==='waiting'?'확인 필요':'진행 중'}</span></div><div className="mt-3 border-t border-surface-800 pt-2">{item.sessions?.length?item.sessions.map(session=><button key={session.id} onClick={()=>openSession(session.id)} className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-2 text-left hover:bg-surface-800/55"><span className="min-w-0"><span className="block truncate text-xs font-semibold text-surface-300">{session.name}</span><span className="mt-0.5 block text-[10px] text-surface-600">{session.owner} · {session.todoTotal>0?`${session.todoDone}/${session.todoTotal} todo`:'단계 수 미기록'}</span></span><span className="text-[11px] text-primary-300">세션 열기 ›</span></button>):<p className="px-2 py-2 text-xs text-surface-600">연결된 세션이 없습니다.</p>}</div></section>)}</div></div>
      ) : <div className="mx-auto w-full max-w-6xl px-3 py-3 pb-[calc(1rem+env(safe-area-inset-bottom,0px))] sm:px-5 sm:py-4 lg:px-8">
        <AgentHomeOverview
              project={project}
              recentSessions={projectSessions.slice(0, 3)}
              workstreams={visibleWorkstreams}
              loading={workstreamsLoading}
              careerLevel={agentHome?.career?.level || project.agent?.careerLevel || 'intern'}
              careerMetrics={agentHome?.career?.metrics || { completedWorkstreams: workstreamTotals.challenges, successfulSkillInvocations: 0 }}
              activity={agentHome?.activity ? { ...agentHome.activity, memberCount: projectMemberCount || agentHome.activity.memberCount } : { totalTurns: 0, dailyTurns: [], daily30: [], memberCount: projectMemberCount || 1 }}
              skills={agentHome?.skills || { mostUsed: [], created: [] }}
              collaboration={agentHome?.collaboration}
              onNewConversation={startNewConversation}
              onEditTeammate={editTeammate}
              onOpenSession={openSession}
              onOpenWork={openWork}
              onOpenAllWork={() => setHomeTab('work')}
            />
      </div>}

       {editingTeammate && (
        <div className="fixed inset-0 z-[80] grid place-items-center bg-black/55 p-3 sm:p-4" onMouseDown={() => setEditingTeammate(false)}>
          <div className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-surface-700 bg-surface-900 shadow-2xl sm:max-h-[86dvh]" onMouseDown={(event) => event.stopPropagation()}>
            <div className="flex shrink-0 items-center justify-between border-b border-surface-800 px-5 py-4"><h2 className="text-lg font-bold text-surface-100">AI 팀원 수정</h2><button onClick={() => setEditingTeammate(false)} className="text-surface-500">닫기</button></div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
              <label className="block text-xs font-semibold text-surface-400">이름<input value={teammateDraft.displayName} onChange={(e)=>setTeammateDraft({...teammateDraft,displayName:e.target.value})} className="mt-1 w-full rounded-xl border border-surface-700 bg-surface-950 px-3 py-2.5 text-sm text-surface-100"/></label>
              <label className="block text-xs font-semibold text-surface-400">역할<input value={teammateDraft.role} onChange={(e)=>setTeammateDraft({...teammateDraft,role:e.target.value})} className="mt-1 w-full rounded-xl border border-surface-700 bg-surface-950 px-3 py-2.5 text-sm text-surface-100"/></label>
              <label className="block text-xs font-semibold text-surface-400">한 줄 소개<textarea value={teammateDraft.tagline} onChange={(e)=>setTeammateDraft({...teammateDraft,tagline:e.target.value})} rows={3} className="mt-1 w-full rounded-xl border border-surface-700 bg-surface-950 px-3 py-2.5 text-sm text-surface-100"/></label>
              <section className="rounded-xl border border-surface-700 bg-surface-950/55 p-3">
                <div className="flex items-start justify-between gap-3"><div><div className="text-xs font-bold text-surface-200">이 팀원이 사용할 Skill</div><p className="mt-1 text-[11px] leading-4 text-surface-500">여기서 끈 Skill은 이 AI 팀원의 새 대화부터 제외됩니다. 카탈로그는 탐색과 상세 확인만 담당합니다.</p></div><span className="shrink-0 text-[11px] text-surface-500">{skills.length-teammateDraft.disabledSkills.length}/{skills.length} 사용</span></div>
                <div className="mt-3 max-h-48 space-y-1 overflow-y-auto pr-1">
                  {skills.map((skill)=>{const enabled=!teammateDraft.disabledSkills.includes(skill.name);return <label key={skill.name} className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2 py-1.5 hover:bg-surface-800/70"><span className="min-w-0"><span className="block truncate font-mono text-xs text-surface-200">/{skill.name}</span>{skill.description&&<span className="block truncate text-[10px] text-surface-600">{skill.description}</span>}</span><input type="checkbox" checked={enabled} onChange={()=>setTeammateDraft((current)=>({...current,disabledSkills:enabled?[...current.disabledSkills,skill.name]:current.disabledSkills.filter((name)=>name!==skill.name)}))} className="h-4 w-4 shrink-0 accent-primary-500" aria-label={`${skill.name} Skill 사용`}/></label>})}
                  {!skills.length&&<p className="px-2 py-3 text-xs text-surface-600">설정할 Skill이 없습니다.</p>}
                </div>
              </section>
              <section aria-labelledby="profile-selection-title">
                <div id="profile-selection-title" className="text-xs font-bold text-surface-200">프로필 선택</div>
                <p className="mt-1 text-[11px] leading-4 text-surface-500">기본 프로필 중 하나를 선택하세요.</p>
                <div className="mt-2 grid grid-cols-6 gap-2 sm:grid-cols-8">{AGENT_CHARACTERS.map((character)=>{const selected=characterFace(teammateDraft.face)===character.id;return <button key={character.id} type="button" title={character.label} onClick={()=>setTeammateDraft((current)=>({...current,face:`character:${character.id}`}))} aria-label={`${character.label}${selected?' (선택됨)':''}`} aria-pressed={selected} className={`relative rounded-xl border p-1 ${selected?'border-primary-400 bg-primary-500/20 ring-1 ring-primary-400/40':'border-surface-700 bg-surface-950 hover:border-surface-500'}`}><AgentCharacterAvatar id={character.id} className="h-auto w-full rounded-lg"/>{selected&&<span className="absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-full bg-primary-500 text-[10px] font-bold text-white" aria-hidden="true">✓</span>}</button>})}</div>
              </section>
              <section className="border-t border-surface-700 pt-3" aria-labelledby="profile-generator-title">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0"><div id="profile-generator-title" className="text-xs font-bold text-surface-200">원하는 프로필이 없나요?</div><p className="mt-1 text-[11px] leading-4 text-surface-500">설명만 입력해 새로 생성해봐요.</p></div>
                  <button type="button" onClick={()=>setCharacterGeneratorOpen((open)=>!open)} aria-expanded={characterGeneratorOpen} aria-controls="profile-generator-panel" className="shrink-0 rounded-lg border border-surface-600 px-3 py-2 text-xs font-bold text-surface-200 hover:border-primary-400 hover:text-primary-300">{characterGeneratorOpen?'접기':'새 프로필 생성'}</button>
                </div>
                {characterGeneratorOpen&&<div id="profile-generator-panel" className="mt-3 rounded-xl border border-surface-700 bg-surface-950/70 p-3"><div className="flex items-center gap-3">{agentFaceImageUrl(teammateDraft.face)&&<img src={agentFaceImageUrl(teammateDraft.face)!} alt="현재 선택한 프로필" className="h-14 w-14 rounded-xl object-cover"/>}<p className="min-w-0 flex-1 text-[11px] leading-4 text-surface-500">Credential Vault의 OpenAI Image 연결을 사용합니다. 키 값은 화면에 노출되지 않습니다.</p></div><textarea value={characterPrompt} onChange={(e)=>setCharacterPrompt(e.target.value)} rows={2} aria-label="새 프로필 설명" placeholder="예: 차분한 한국인 보안 엔지니어, 짧은 머리, 남색 셔츠, 작은 자물쇠 소품" className="mt-3 w-full rounded-xl border border-surface-700 bg-surface-900 px-3 py-2 text-sm text-surface-100"/><button type="button" onClick={generateCharacter} disabled={characterGenerating||!characterPrompt.trim()} className="tone-accent tone-action mt-2 rounded-lg px-3 py-2 text-xs font-bold disabled:opacity-50">{characterGenerating?'생성 중…':'새 프로필 생성'}</button></div>}
              </section>
            </div>
            <div className="flex shrink-0 justify-end gap-2 border-t border-surface-800 bg-surface-900 px-5 py-4"><button onClick={() => setEditingTeammate(false)} className="rounded-xl px-4 py-2 text-sm text-surface-400">취소</button><button onClick={saveTeammate} disabled={teammateSaving||!teammateDraft.displayName.trim()} className="tone-accent tone-action rounded-xl px-4 py-2 text-sm font-bold disabled:opacity-50">{teammateSaving?'저장 중…':'저장'}</button></div>
          </div>
        </div>
      )}

      {instructionsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={() => setInstructionsOpen(false)}>
          <div className="flex max-h-[86vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-surface-700 bg-surface-950 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-4 border-b border-surface-800 px-5 py-4">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary-300">Project Instructions</div>
                <h2 className="mt-1 text-lg font-bold text-gray-100">프로젝트 지침</h2>
              </div>
              <button onClick={() => setInstructionsOpen(false)} className="rounded-lg border border-surface-700 bg-surface-900 px-3 py-1.5 text-sm font-semibold text-surface-300 hover:text-gray-100">닫기</button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
              {instructionsLoading ? (
                <div className="py-16 text-center text-sm text-surface-500">프로젝트 지침을 불러오는 중…</div>
              ) : instructionsContent ? (
                <MarkdownReadSurface
                  content={instructionsContent}
                  components={{}}
                  className="prose prose-invert prose-sm max-w-none markdown-document"
                />
              ) : (
                <div className="rounded-xl border border-surface-800 bg-surface-900/70 p-4 text-sm text-surface-400">이 프로젝트에는 아직 AGENTS.md 지침 파일이 없습니다.</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
