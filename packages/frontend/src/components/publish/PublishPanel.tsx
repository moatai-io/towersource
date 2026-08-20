import { useState, useEffect, useCallback, useMemo } from 'react';
import { useConfirm } from '../../hooks/useDialog';
import { isOperatorOrAdmin } from '../../utils/auth';
import i18n from '../../i18n';

// Legacy manifests still carry these values. The normal Publishing Hub no longer
// presents them as user-facing sharing modes: every listed artifact uses the
// project-scoped discovery + link-sharing/noindex product contract.
type Access = 'public' | 'unlisted' | 'private' | 'internal';

interface Site {
  name: string;
  slug?: string;           // Phase 1: actual folder/URL name; falls back to `name` when absent
  description: string;
  access: Access;
  created_at: string;
  status?: string;
  files?: number;
  deploy_target?: string;
  external_url?: string;
  thumbnail_url?: string;
  thumbnail_status?: 'pending' | 'ready' | 'failed' | 'skipped';
  thumbnail_error?: string;
  project?: string;        // 2026-04-26: workspace project provenance, used for grouping
  archived?: boolean;      // 2026-05-08: soft-deleted (hidden from default Hub view)
  archived_at?: string;
  tags?: string[];         // 2026-05-08: free-form labels, multi-select, orthogonal to access
}

interface App {
  name: string;
  port?: number;
  path?: string;
  description: string;
  access: Access;
  status?: string;
  statusCode?: number;
  created_at: string;
  deploy_target?: string;
  external_url?: string;
  project?: string;
  archived?: boolean;
  tags?: string[];
}

interface SharedFile {
  id: string;
  name: string;
  fileName: string;
  file_path: string;
  ext: string;
  token?: string;
  url?: string;
  expires_at?: string;
  created_at: string;
  expired?: boolean;
  project?: string;
}

interface PublishInfo {
  role: 'full' | 'managed' | 'standalone';
  gatewayConfigured?: boolean;
  gatewayUrl?: string;
  gatewayEnabled?: boolean;
}

interface GatewayStatus {
  connected: boolean;
  customer?: string;
  profile?: string;
  quotas?: {
    sites: { used: number; limit: number };
    apps: { used: number; limit: number };
  };
  lastDeploy?: {
    name: string;
    type: string;
    url?: string;
    at: string;
    durationMs?: number;
  } | null;
  deploys?: Array<{
    name: string;
    type: string;
    target?: string;
    url?: string;
    at: string;
    durationMs?: number;
  }>;
  gatewayVersion?: string;
  checkedAt: string;
  error?: string;
  latencyMs?: number;
}

interface PublishPanelProps {
  open: boolean;
  onClose: () => void;
  variant?: 'modal' | 'embedded';
}

const API_BASE = '/api/publish';
const PUBLIC_HOST = window.location.host;

type SortMode = 'date-desc' | 'date-asc' | 'name-asc' | 'name-desc';
function sortLabel(mode: SortMode): string {
  return i18n.t(`publish.sort.${mode}`);
}

const UNTRACKED_GROUP = '__untracked__';
const UNTAGGED_GROUP = '__untagged__';

type GroupMode = 'project' | 'tag' | 'none';
function groupLabel(mode: GroupMode): string {
  return i18n.t(`publish.group.${mode}`);
}

// Persist UI prefs across sessions so the user doesn't have to re-pick on every open.
const PREF_KEY = 'publishPanel.prefs.v1';
interface UIPrefs {
  sort: SortMode;
  groupBy: GroupMode;
  collapsed: string[];   // group keys collapsed
  showArchived: boolean; // show archived (soft-deleted) sites in the list
}
function loadPrefs(): UIPrefs {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Migrate from v0 (groupByProject: boolean) → v1 (groupBy: 'project'|'tag'|'none')
      let groupBy: GroupMode;
      if (typeof parsed.groupBy === 'string' && ['project','tag','none'].includes(parsed.groupBy)) {
        groupBy = parsed.groupBy;
      } else if (typeof parsed.groupByProject === 'boolean') {
        groupBy = parsed.groupByProject ? 'project' : 'none';
      } else {
        groupBy = 'project';
      }
      return {
        sort: (parsed.sort as SortMode) || 'date-desc',
        groupBy,
        collapsed: Array.isArray(parsed.collapsed) ? parsed.collapsed : [],
        showArchived: parsed.showArchived === true,
      };
    }
  } catch { /* fall through */ }
  return { sort: 'date-desc', groupBy: 'project', collapsed: [], showArchived: false };
}
function savePrefs(p: UIPrefs) {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

function compareForSort<T extends { name?: string; fileName?: string; created_at: string }>(a: T, b: T, mode: SortMode): number {
  const nameA = a.name || a.fileName || '';
  const nameB = b.name || b.fileName || '';
  switch (mode) {
    case 'name-asc':  return nameA.localeCompare(nameB);
    case 'name-desc': return nameB.localeCompare(nameA);
    case 'date-asc':  return (a.created_at || '').localeCompare(b.created_at || '');
    case 'date-desc':
    default:          return (b.created_at || '').localeCompare(a.created_at || '');
  }
}

// Archive/tag operations remain privileged in the current backend contract.
const canManagePublications = isOperatorOrAdmin;

export function PublishPanel({ open, onClose, variant = 'modal' }: PublishPanelProps) {
  const confirm = useConfirm();
  const [sites, setSites] = useState<Site[]>([]);
  const [apps, setApps] = useState<App[]>([]);
  const [sharedFiles, setSharedFiles] = useState<SharedFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'sites' | 'files'>('sites');
  const [publishInfo, setPublishInfo] = useState<PublishInfo | null>(null);
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus | null>(null);
  const [gwLoading, setGwLoading] = useState(false);
  const [prefs, setPrefs] = useState<UIPrefs>(() => loadPrefs());

  // ── Visibility management (admin/operator only) ──
  // Legacy manifests still carry an access tier, but Publishing Hub presents
  // one product contract: link sharing + noindex, scoped to project membership.
  // Admin/operator selection remains for archive/tag management only.
  const [selectedSlugs, setSelectedSlugs] = useState<Set<string>>(new Set());
  const [editingTagsFor, setEditingTagsFor] = useState<string | null>(null);
  const [shareBusyId, setShareBusyId] = useState<string | null>(null);
  const [allTags, setAllTags] = useState<Array<{ tag: string; count: number }>>([]);
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set());
  // folder → display name (e.g. "project-9f07a9ab" → "강태형대표님 작업").
  // Backend joins workspace projects table; frontend just uses it for rendering.
  // Fallback to folder name when missing.
  const [projectDisplayMap, setProjectDisplayMap] = useState<Record<string, string>>({});
  const [accessBusy, setAccessBusy] = useState(false);
  const canEditAccess = canManagePublications();

  // Persist prefs whenever they change.
  useEffect(() => { savePrefs(prefs); }, [prefs]);

  const setSort = (sort: SortMode) => setPrefs(p => ({ ...p, sort }));
  const setGroupBy = (groupBy: GroupMode) => setPrefs(p => ({ ...p, groupBy }));
  const toggleShowArchived = () => setPrefs(p => ({ ...p, showArchived: !p.showArchived }));
  const toggleCollapsed = (key: string) => setPrefs(p => ({
    ...p,
    collapsed: p.collapsed.includes(key)
      ? p.collapsed.filter(k => k !== key)
      : [...p.collapsed, key],
  }));

  const authHeaders = (): Record<string, string> => {
    const token = localStorage.getItem('token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const headers = authHeaders();
      const [statusRes, infoRes, tagsRes, sharedRes] = await Promise.all([
        fetch(`${API_BASE}/status`, { headers }),
        fetch(`${API_BASE}/info`, { headers }),
        fetch(`${API_BASE}/sites/tags`, { headers }),
        fetch('/api/shares/external', { headers }),
      ]);
      if (statusRes.status === 401) throw new Error(i18n.t('publish.loginRequired'));
      if (!statusRes.ok) throw new Error(i18n.t('publish.serviceUnavailable'));
      const health = await statusRes.json();
      const info = await infoRes.json().catch(() => null);
      const tagsJson = await tagsRes.json().catch(() => ({ tags: [] }));
      const sharedJson = sharedRes.ok ? await sharedRes.json().catch(() => []) : [];
      setSites(health.sites || []);
      setApps(health.apps || []);
      setSharedFiles(Array.isArray(sharedJson) ? sharedJson : []);
      setAllTags(Array.isArray(tagsJson.tags) ? tagsJson.tags : []);
      setProjectDisplayMap(health.projects && typeof health.projects === 'object' ? health.projects : {});
      if (info) {
        setPublishInfo(info);
        // Fetch gateway status for managed servers
        if (info.role === 'managed') {
          fetch('/api/publish/gateway-status', { headers })
            .then(r => r.ok ? r.json() : null)
            .then(gs => { if (gs) setGatewayStatus(gs); })
            .catch(() => {});
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : i18n.t('publish.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) fetchData();
  }, [open, fetchData]);

  // ── Archive (soft-delete) handlers ──
  const archiveOne = useCallback(async (slug: string, siteName: string) => {
    if (!canEditAccess) return;
    const ok = await confirm({
      title: i18n.t('publish.archive.title'),
      message: i18n.t('publish.archive.message', { name: siteName }),
      confirmLabel: i18n.t('publish.archive.confirm'),
    });
    if (!ok) return;
    setAccessBusy(true);
    setError('');
    try {
      const headers = authHeaders();
      const r = await fetch(`/api/publish/sites/${encodeURIComponent(slug)}/archive`, {
        method: 'POST', headers,
      });
      if (!r.ok) {
        const msg = await r.text().catch(() => '');
        throw new Error(msg || `HTTP ${r.status}`);
      }
      await fetchData();
    } catch (e: any) {
      setError(i18n.t('publish.errors.archive', { error: e?.message || e }));
    } finally {
      setAccessBusy(false);
    }
  }, [canEditAccess, fetchData, confirm]);

  const restoreOne = useCallback(async (slug: string) => {
    if (!canEditAccess) return;
    setAccessBusy(true);
    setError('');
    try {
      const headers = authHeaders();
      const r = await fetch(`/api/publish/sites/${encodeURIComponent(slug)}/unarchive`, {
        method: 'POST', headers,
      });
      if (!r.ok) {
        const msg = await r.text().catch(() => '');
        throw new Error(msg || `HTTP ${r.status}`);
      }
      await fetchData();
    } catch (e: any) {
      setError(i18n.t('publish.errors.restore', { error: e?.message || e }));
    } finally {
      setAccessBusy(false);
    }
  }, [canEditAccess, fetchData]);

  const archiveBulk = useCallback(async () => {
    if (!canEditAccess || selectedSlugs.size === 0) return;
    const n = selectedSlugs.size;
    const ok = await confirm({
      title: i18n.t('publish.archive.bulkTitle'),
      message: i18n.t('publish.archive.bulkMessage', { count: n }),
      confirmLabel: i18n.t('publish.archive.confirm'),
    });
    if (!ok) return;
    setAccessBusy(true);
    setError('');
    try {
      const headers = { ...authHeaders(), 'Content-Type': 'application/json' };
      const r = await fetch('/api/publish/sites/archive/bulk', {
        method: 'POST', headers,
        body: JSON.stringify({ slugs: Array.from(selectedSlugs) }),
      });
      if (!r.ok) {
        const msg = await r.text().catch(() => '');
        throw new Error(msg || `HTTP ${r.status}`);
      }
      setSelectedSlugs(new Set());
      await fetchData();
    } catch (e: any) {
      setError(i18n.t('publish.errors.bulkArchive', { error: e?.message || e }));
    } finally {
      setAccessBusy(false);
    }
  }, [canEditAccess, selectedSlugs, fetchData, confirm]);

  // ── Tag handlers ──
  const setTagsFor = useCallback(async (slug: string, tags: string[]) => {
    if (!canEditAccess) return;
    setAccessBusy(true);
    setError('');
    try {
      const headers = { ...authHeaders(), 'Content-Type': 'application/json' };
      const r = await fetch(`/api/publish/sites/${encodeURIComponent(slug)}/tags`, {
        method: 'PATCH', headers, body: JSON.stringify({ tags }),
      });
      if (!r.ok) {
        const msg = await r.text().catch(() => '');
        throw new Error(msg || `HTTP ${r.status}`);
      }
      await fetchData();
    } catch (e: any) {
      setError(i18n.t('publish.errors.tags', { error: e?.message || e }));
    } finally {
      setAccessBusy(false);
    }
  }, [canEditAccess, fetchData]);

  const toggleSelectSlug = (slug: string) => {
    setSelectedSlugs(prev => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug); else next.add(slug);
      return next;
    });
  };

  // auto-refresh every 15s while open
  useEffect(() => {
    if (!open) return;
    const interval = setInterval(fetchData, 15000);
    return () => clearInterval(interval);
  }, [open, fetchData]);

  // Merge gateway deploys into local sites/apps lists (managed mode only)
  // Gateway deploys are prefixed with "<customer>--" on the gateway side; strip for display
  const customerPrefix = gatewayStatus?.customer ? `${gatewayStatus.customer}--` : '';
  const gatewaySites: Site[] = (gatewayStatus?.deploys || [])
    .filter(d => d.type === 'static')
    .filter(d => !sites.some(s => s.name === d.name || s.name === d.name.replace(customerPrefix, '')))
    .map<Site>(d => ({
      name: d.name.replace(customerPrefix, ''),
      description: i18n.t('publish.gatewayDeployment', { target: d.target || 'cloudflare-pages' }),
      access: 'public',
      created_at: d.at,
      status: 'live',
      deploy_target: d.target,
      external_url: d.url,
    }));
  const gatewayApps: App[] = (gatewayStatus?.deploys || [])
    .filter(d => d.type !== 'static')
    .filter(d => !apps.some(a => a.name === d.name || a.name === d.name.replace(customerPrefix, '')))
    .map<App>(d => ({
      name: d.name.replace(customerPrefix, ''),
      description: i18n.t('publish.gatewayDeployment', { target: d.target || 'azure-container-apps' }),
      access: 'public',
      created_at: d.at,
      status: 'external',
      deploy_target: d.target,
      external_url: d.url,
    }));

  const allSites = useMemo(() => [...sites, ...gatewaySites], [sites, gatewaySites]);
  const allApps = useMemo(() => [...apps, ...gatewayApps], [apps, gatewayApps]);
  const visibleSharedFiles = useMemo(() => sharedFiles.filter(s => !s.expired), [sharedFiles]);

  // Apply archived/tag filters. Legacy access tiers no longer affect the Hub UI;
  // every listed site follows the same link-sharing + noindex contract.
  const visibleSites = useMemo(() => {
    let arr = allSites;
    if (!prefs.showArchived) arr = arr.filter(s => !s.archived);
    if (tagFilter.size > 0) {
      // Tag filter is OR-include — show rows that carry at least one selected tag.
      arr = arr.filter(s => (s.tags || []).some(t => tagFilter.has(t)));
    }
    return arr;
  }, [allSites, prefs.showArchived, tagFilter]);
  const visibleApps = useMemo(() => {
    let arr = allApps;
    if (!prefs.showArchived) arr = arr.filter(a => !a.archived);
    if (tagFilter.size > 0) {
      arr = arr.filter(a => (a.tags || []).some(t => tagFilter.has(t)));
    }
    return arr;
  }, [allApps, prefs.showArchived, tagFilter]);

  const toggleTagFilter = (tag: string) => {
    setTagFilter(prev => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag); else next.add(tag);
      return next;
    });
  };

  const archivedCount = useMemo(
    () => allSites.filter(s => s.archived).length + allApps.filter(a => a.archived).length,
    [allSites, allApps],
  );

  // Most recent local deploy across sites + apps. Drives the "Local Publishing"
  // card's "최근" display. See workspace/decisions/2026-04-29-publishing-local-first.md
  // — replaces the prior gatewayStatus.lastDeploy (which only saw gateway-routed
  // deploys and went stale once users moved to local-first publishing).
  const localLastDeploy = useMemo(() => {
    const all: Array<{ name: string; at: string; kind: 'site' | 'app' }> = [
      ...allSites.map(s => ({ name: s.slug || s.name, at: s.created_at || '', kind: 'site' as const })),
      ...allApps.map(a => ({ name: a.name, at: a.created_at || '', kind: 'app' as const })),
    ];
    if (all.length === 0) return null;
    return all.reduce((latest, x) => (x.at.localeCompare(latest.at) > 0 ? x : latest));
  }, [allSites, allApps]);

  // Group + sort sites/apps by current prefs.
  // Returns ordered array of [groupKey, items[]] tuples so render order is stable.
  // groupedSites/groupedApps work on the archived/tag-filtered collections.
  const groupedSites = useMemo(
    () => groupAndSort(visibleSites, prefs.groupBy, prefs.sort, projectDisplayMap),
    [visibleSites, prefs.groupBy, prefs.sort, projectDisplayMap],
  );
  const groupedApps = useMemo(
    () => groupAndSort(visibleApps, prefs.groupBy, prefs.sort, projectDisplayMap),
    [visibleApps, prefs.groupBy, prefs.sort, projectDisplayMap],
  );
  const groupedSharedFiles = useMemo(
    () => groupAndSort(visibleSharedFiles, prefs.groupBy === 'tag' ? 'none' : prefs.groupBy, prefs.sort, projectDisplayMap),
    [visibleSharedFiles, prefs.groupBy, prefs.sort, projectDisplayMap],
  );

  if (!open) return null;

  const totalSites = allSites.length;
  const totalApps = allApps.length;
  const totalSharedFiles = visibleSharedFiles.length;
  const appsUp = allApps.filter(a => a.status === 'up' || a.status === 'external').length;

  const statusDot = (status?: string) => {
    const colors: Record<string, string> = {
      up: 'tone-success tone-bg', live: 'tone-success tone-bg',
      down: 'tone-danger tone-bg', missing: 'tone-danger tone-bg',
      timeout: 'tone-warning tone-bg', 'no-port': 'tone-warning tone-bg',
    };
    return colors[status || ''] || 'bg-neutral-500';
  };

  const sharingBadge = (
    <span className="tone-pill tone-info text-[11px] px-1 py-px rounded shrink-0" title={i18n.t('publish.linkSharingHint')}>
      {i18n.t('publish.linkSharing')}
    </span>
  );

  const revokeSharedFile = useCallback(async (share: SharedFile) => {
    const ok = await confirm({
      title: i18n.t('publish.share.revokeTitle'),
      message: i18n.t('publish.share.revokeMessage', { name: share.fileName || share.name }),
      confirmLabel: i18n.t('publish.share.revoke'),
    });
    if (!ok) return;
    setShareBusyId(share.id);
    setError('');
    try {
      const r = await fetch(`/api/shares/${encodeURIComponent(share.id)}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      if (!r.ok) {
        const msg = await r.text().catch(() => '');
        throw new Error(msg || `HTTP ${r.status}`);
      }
      await fetchData();
    } catch (e: any) {
      setError(i18n.t('publish.errors.revokeShare', { error: e?.message || e }));
    } finally {
      setShareBusyId(null);
    }
  }, [confirm, fetchData]);

  const copyToClipboard = async (text: string, label?: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopiedKey(label || text);
      setTimeout(() => setCopiedKey(k => (k === (label || text) ? null : k)), 1500);
    } catch {
      /* ignore */
    }
  };

  // Build URL for a given site. Wildcard subdomains are the canonical
  // Publishing URL; /sites/<slug>/ is compatibility-only and is not shown.
  const siteUrlFor = (s: Site): string => {
    const slug = s.slug || s.name;
    return s.external_url || `${window.location.protocol}//${slug}.${PUBLIC_HOST}/`;
  };

  const appUrlFor = (a: App): string => {
    return a.external_url
      || (a.path
          ? `${window.location.protocol}//${PUBLIC_HOST}${a.path}`
          : `${window.location.protocol}//${a.name}.${PUBLIC_HOST}/`);
  };

  const isEmbedded = variant === 'embedded';
  const panel = (
      <div data-testid="publishing-hub" aria-label={i18n.t('publish.hubTitle')} className={`${variant === 'modal' ? 'relative bg-neutral-900 border border-neutral-700 rounded-xl shadow-2xl w-[820px] max-w-[95vw] h-[640px] max-h-[90vh]' : 'publish-panel-embedded h-full w-full bg-neutral-900'} flex flex-col overflow-hidden`}>
        {/* Header */}
        <div className={`${isEmbedded ? 'px-7 py-4' : 'px-5 py-3'} flex items-center justify-between border-b border-neutral-800 shrink-0`}>
          <div className="flex items-center gap-3">
            <div className={`${isEmbedded ? 'w-9 h-9' : 'w-7 h-7'} rounded-lg tone-pill tone-accent flex items-center justify-center`}>
              <svg className={`${isEmbedded ? 'w-5 h-5' : 'w-4 h-4'} tone-text`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <p className={`${isEmbedded ? 'text-2xl' : 'text-base'} font-semibold text-neutral-100`}>{i18n.t('publish.title')}</p>
                {publishInfo && (
                  <span className={`text-[11px] px-1.5 py-0.5 rounded-full font-medium uppercase tracking-wider ${
                    publishInfo.role === 'full' ? 'bg-violet-500/15 text-violet-400 border border-violet-500/30' :
                    publishInfo.role === 'managed' ? 'bg-sky-500/15 text-sky-400 border border-sky-500/30' :
                    'bg-neutral-500/15 text-neutral-400 border border-neutral-500/30'
                  }`}>{publishInfo.role}</span>
                )}
              </div>
              <p className={`${isEmbedded ? 'text-base' : 'text-[12px]'} text-neutral-400`}>{PUBLIC_HOST}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={fetchData}
              disabled={loading}
              className="p-1.5 text-neutral-500 hover:text-neutral-300 transition-colors disabled:opacity-40"
              title={i18n.t('publish.refresh')}
            >
              <svg className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
            <button onClick={onClose} className="p-1.5 text-neutral-500 hover:text-neutral-300 transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Stats + tab + sort/group controls */}
        <div className={`${isEmbedded ? 'gap-3 px-7 py-3.5' : 'gap-2 px-5 py-2.5'} flex flex-wrap items-center border-b border-neutral-800/50 shrink-0`}>
          {[
            { label: i18n.t('publish.sites'), value: totalSites, color: 'text-blue-400' },
            { label: i18n.t('publish.apps'), value: totalApps, color: 'text-purple-400' },
            { label: i18n.t('publish.shared'), value: totalSharedFiles, color: 'text-sky-400' },
            { label: i18n.t('publish.online'), value: `${appsUp}/${totalApps}`, color: appsUp === totalApps ? 'tone-success tone-text' : 'tone-warning tone-text' },
          ].map(s => (
            <div key={s.label} className={`${isEmbedded ? 'px-4 py-2 rounded-lg' : 'px-2.5 py-1 rounded-md'} flex items-center gap-2 bg-neutral-800/50`}>
              <span className={`${isEmbedded ? 'text-sm' : 'text-[12px]'} text-neutral-400 uppercase tracking-wider`}>{s.label}</span>
              <span className={`${isEmbedded ? 'text-lg' : 'text-sm'} font-bold ${s.color}`}>{s.value}</span>
            </div>
          ))}

          <div className="flex-1" />

          {tab === 'sites' && (
            <>
              {/* "휴지통" 토글 — archivedCount=0 면 숨겨서 잡음 줄임 */}
              {(archivedCount > 0 || prefs.showArchived) && (
                <button
                  onClick={toggleShowArchived}
                  title={prefs.showArchived ? i18n.t('publish.hideTrash') : i18n.t('publish.showTrash')}
                  className={`flex items-center gap-1 px-2 py-1 text-[13px] rounded-md border transition-colors ${
                    prefs.showArchived
                      ? 'bg-neutral-700 text-neutral-200 border-neutral-500'
                      : 'bg-neutral-800/60 text-neutral-500 border-neutral-700 hover:text-neutral-300'
                  }`}
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3" />
                  </svg>
                  <span>{i18n.t('publish.trash')}</span>
                  <span className="text-[11px] opacity-70">{archivedCount}</span>
                </button>
              )}

              {/* 그룹 모드 — 3-way (프로젝트 / 태그 / 없음) */}
              <select
                value={prefs.groupBy}
                onChange={(e) => setGroupBy(e.target.value as GroupMode)}
                className="px-2 py-1 text-[13px] bg-neutral-800/60 text-neutral-300 border border-neutral-700 rounded-md hover:border-neutral-600 focus:outline-none focus:border-primary-500/40 cursor-pointer"
                title={i18n.t('publish.groupBy')}
              >
                {(['project', 'tag', 'none'] as GroupMode[]).map(m => (
                  <option key={m} value={m}>{i18n.t('publish.groupOption', { label: groupLabel(m) })}</option>
                ))}
              </select>

              <select
                value={prefs.sort}
                onChange={(e) => setSort(e.target.value as SortMode)}
                className="px-2 py-1 text-[13px] bg-neutral-800/60 text-neutral-300 border border-neutral-700 rounded-md hover:border-neutral-600 focus:outline-none focus:border-primary-500/40 cursor-pointer"
                title={i18n.t('publish.sortBy')}
              >
                {(['date-desc', 'date-asc', 'name-asc', 'name-desc'] as SortMode[]).map(m => (
                  <option key={m} value={m}>{sortLabel(m)}</option>
                ))}
              </select>
            </>
          )}

          <div className="flex gap-0.5 bg-neutral-800/60 rounded-md p-0.5">
            <button
              onClick={() => setTab('sites')}
              className={`px-2.5 py-1 text-[13px] font-medium rounded transition-colors ${tab === 'sites' ? 'bg-neutral-700 text-white' : 'text-neutral-500 hover:text-neutral-300'}`}
            >{i18n.t('publish.sites')}</button>
            <button
              onClick={() => setTab('files')}
              className={`px-2.5 py-1 text-[13px] font-medium rounded transition-colors ${tab === 'files' ? 'bg-neutral-700 text-white' : 'text-neutral-500 hover:text-neutral-300'}`}
            >{i18n.t('publish.files')}</button>
          </div>
        </div>

        {tab === 'sites' && (
          <div className="flex flex-wrap items-center gap-2 px-5 py-2 border-b border-neutral-800/50 shrink-0">
            <p className="text-[12px] text-neutral-400">
              {i18n.t('publish.hubScopeDescription')}
            </p>
            <div className="flex-1" />
            {canEditAccess && selectedSlugs.size > 0 && (
              <>
                <span className="text-[12px] text-neutral-400">{i18n.t('publish.selectedCount', { count: selectedSlugs.size })}</span>
                <button
                  key="bulk-archive"
                  onClick={() => archiveBulk()}
                  disabled={accessBusy}
                  className="flex items-center gap-1 px-2 py-0.5 text-[12px] rounded border bg-red-500/10 text-red-300 border-red-500/30 hover:bg-red-500/20 hover:text-red-200 transition-colors disabled:opacity-40"
                  title={i18n.t('publish.archive.selectedHint')}
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3" />
                  </svg>
                  {i18n.t('publish.trash')}
                </button>
                <button
                  onClick={() => setSelectedSlugs(new Set())}
                  disabled={accessBusy}
                  className="text-[12px] text-neutral-500 hover:text-neutral-300 underline underline-offset-2 ml-1"
                >
                  {i18n.t('publish.clearSelection')}
                </button>
              </>
            )}
          </div>
        )}

        {/* Tag filter chips — only render when there are tags in use, to keep
            the panel compact for users who haven't adopted tags yet. OR-include
            semantics (matches the AI-friendly "click to narrow" mental model). */}
        {tab === 'sites' && allTags.length > 0 && (
          <div className={`${isEmbedded ? 'gap-2 px-7 py-3' : 'gap-1.5 px-5 py-1.5'} flex flex-wrap items-center border-b border-neutral-800/50 shrink-0`}>
            <span className={`${isEmbedded ? 'text-sm' : 'text-[12px]'} text-neutral-400 uppercase tracking-wider mr-1`}>{i18n.t('publish.tags')}</span>
            {allTags.slice(0, 16).map(({ tag, count }) => {
              const on = tagFilter.has(tag);
              return (
                <button
                  key={tag}
                  onClick={() => toggleTagFilter(tag)}
                  className={`${isEmbedded ? 'px-2.5 py-1 text-sm rounded-md' : 'px-1.5 py-0.5 text-[12px] rounded'} flex items-center gap-1 border transition-colors ${
                    on
                      ? 'bg-violet-500/20 text-violet-200 border-violet-500/40'
                      : 'bg-violet-500/5 text-violet-400/70 border-violet-500/15 hover:text-violet-300 hover:bg-violet-500/10'
                  }`}
                  title={on ? i18n.t('publish.disableTagFilter', { tag }) : i18n.t('publish.enableTagFilter', { tag })}
                >
                  <span>{tag}</span>
                  <span className="text-[11px] opacity-60">{count}</span>
                </button>
              );
            })}
            {allTags.length > 16 && (
              <span className="text-[11px] text-neutral-600">+{allTags.length - 16}</span>
            )}
            {tagFilter.size > 0 && (
              <button
                onClick={() => setTagFilter(new Set())}
                className="text-[12px] text-neutral-500 hover:text-neutral-300 underline underline-offset-2"
              >
                {i18n.t('publish.clearTags')}
              </button>
            )}
          </div>
        )}

        {/* Role banner — Local Publishing card (managed mode).
            Replaces the prior "Managed Service" card whose Sites/Apps/quota numbers
            came from gateway_deploy_log on tower.tower.example.com — those reflected the
            deprecated CF-Pages flow only and went stale once users moved to local-
            subdomain publishing. New card sources its numbers from the same local
            manifest the header stat chips use, so the two views always agree.
            See workspace/decisions/2026-04-29-publishing-local-first.md. */}
        {publishInfo?.role === 'managed' && (
          <div className="mx-5 mt-3 px-3 py-2.5 rounded-lg border bg-sky-500/5 border-sky-500/20">
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 shrink-0 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-[13px] font-medium text-sky-300">{i18n.t('publish.localPublishing')}</p>
                  <span className="text-[11px] text-neutral-500">{PUBLIC_HOST}</span>
                </div>
              </div>
              {/* Gateway health dot — upstream signal for legacy gateway-routed
                  sites (still supported per D13 exception cases). Sandbox-hosted
                  tools don't go through this. Click to force a fresh status fetch.
                  D13: workspace/decisions/2026-05-02-execution-sandbox-d13-aca-deprecation.md */}
              {publishInfo.gatewayConfigured && (
                <button
                  onClick={async () => {
                    setGwLoading(true);
                    try {
                      const headers = authHeaders();
                      const r = await fetch('/api/publish/gateway-status?force=true', { headers });
                      if (r.ok) setGatewayStatus(await r.json());
                    } catch {}
                    setGwLoading(false);
                  }}
                  disabled={gwLoading}
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-neutral-500 hover:text-neutral-300 transition-colors disabled:opacity-40"
                  title={
                    gatewayStatus?.connected
                      ? i18n.t('publish.gatewayConnected', { latency: gatewayStatus.latencyMs !== undefined ? ` (${gatewayStatus.latencyMs}ms)` : '' })
                      : gatewayStatus?.error
                        ? i18n.t('publish.gatewayError', { error: gatewayStatus.error })
                        : i18n.t('publish.gatewayCheck')
                  }
                >
                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${
                    gatewayStatus?.connected
                      ? 'tone-success tone-bg'
                      : gatewayStatus?.error
                        ? 'tone-danger tone-bg'
                        : 'bg-neutral-600'
                  } ${gwLoading ? 'animate-pulse' : ''}`} />
                  <span>{i18n.t('publish.gateway')}</span>
                </button>
              )}
            </div>

            {/* Local stats + last deploy — sourced from the same manifest as the header */}
            <div className="flex items-center gap-3 mt-2 pt-2 border-t border-sky-500/10 text-[12px]">
              <div className="flex items-center gap-1.5">
                <span className="text-neutral-500">{i18n.t('publish.sites')}</span>
                <span className="font-medium text-sky-300">{totalSites}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-neutral-500">{i18n.t('publish.apps')}</span>
                <span className="font-medium text-sky-300">{totalApps}</span>
              </div>
              {localLastDeploy && (
                <>
                  <div className="w-px h-3 bg-sky-500/20" />
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-neutral-500">{i18n.t('publish.recent')}</span>
                    <span className="text-sky-400/80 truncate">{localLastDeploy.name}</span>
                    {localLastDeploy.at && (
                      <span className="text-[11px] text-neutral-600 shrink-0">
                        {new Date(localLastDeploy.at).toLocaleDateString(i18n.resolvedLanguage || i18n.language)}
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
        {publishInfo?.role === 'full' && publishInfo.gatewayEnabled && (
          <div className="mx-5 mt-3 px-3 py-2 bg-violet-500/10 border border-violet-500/20 rounded-lg flex items-center gap-2">
            <svg className="w-4 h-4 text-violet-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" />
            </svg>
            <div className="flex-1">
              <p className="text-[13px] text-violet-300">{i18n.t('publish.centralGatewayActive')}</p>
              <p className="text-[12px] text-violet-400/60">{i18n.t('publish.gatewayProcessing')}</p>
            </div>
          </div>
        )}

        {/* Content */}
        <div className={`${isEmbedded ? 'px-7 py-6' : 'px-5 py-4'} flex-1 overflow-y-auto`}>
          {error ? (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center">
                <svg className="w-6 h-6 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
              </div>
              <p className="text-base text-neutral-400">{error}</p>
              <button onClick={fetchData} className="px-4 py-2 text-sm bg-neutral-800 hover:bg-neutral-700 rounded-lg text-neutral-300 transition-colors">
                {i18n.t('publish.retry')}
              </button>
            </div>
          ) : tab === 'sites' ? (
            <div className="space-y-5">
              {/* Sites */}
              <Section
                title={i18n.t('publish.sites')}
                hint={i18n.t('publish.sitesHint')}
                emptyText={i18n.t('publish.emptySites')}
                groups={groupedSites}
                groupBy={prefs.groupBy !== 'none'}
                collapsed={prefs.collapsed}
                onToggleCollapsed={toggleCollapsed}
                renderRow={(s) => {
                  const site = s as Site;
                  const url = siteUrlFor(site);
                  const justCopied = copiedKey === url;
                  const isGateway = site.description?.startsWith(i18n.t('publish.gatewayDeploymentPrefix'));
                  const slugKey = site.slug || site.name;
                  // Gateway-routed sites live on CF/ACA — visibility is governed
                  // by the external platform, not our manifest. Hide the editor
                  // controls there to avoid suggesting a no-op.
                  const editable = canEditAccess && !isGateway;
                  return (
                    <SiteRow
                      key={site.name}
                      site={site}
                      url={url}
                      justCopied={justCopied}
                      isGateway={!!isGateway}
                      statusDot={statusDot(site.status)}
                      accessBadge={sharingBadge}
                      onCopy={() => copyToClipboard(url)}
                      canEdit={editable}
                      selected={selectedSlugs.has(slugKey)}
                      onToggleSelect={() => toggleSelectSlug(slugKey)}
                      accessBusy={accessBusy}
                      editingTags={editingTagsFor === slugKey}
                      onStartEditTags={() => setEditingTagsFor(slugKey)}
                      onCancelEditTags={() => setEditingTagsFor(null)}
                      onSetTags={(next) => { setTagsFor(slugKey, next); setEditingTagsFor(null); }}
                      allTags={allTags}
                      onArchive={() => archiveOne(slugKey, site.name)}
                      onRestore={() => restoreOne(slugKey)}
                    />
                  );
                }}
              />

              {/* Apps */}
              <Section
                title={i18n.t('publish.apps')}
                hint={i18n.t('publish.appsHint')}
                emptyText={i18n.t('publish.emptyApps')}
                groups={groupedApps}
                groupBy={prefs.groupBy !== 'none'}
                collapsed={prefs.collapsed}
                onToggleCollapsed={toggleCollapsed}
                renderRow={(a) => {
                  const app = a as App;
                  const url = appUrlFor(app);
                  const isExternal = !!app.external_url;
                  const isGateway = app.description?.startsWith(i18n.t('publish.gatewayDeploymentPrefix'));
                  return (
                    <AppRow
                      key={app.name}
                      app={app}
                      url={url}
                      isExternal={isExternal}
                      isGateway={!!isGateway}
                      statusDot={statusDot(app.status)}
                      accessBadge={sharingBadge}
                    />
                  );
                }}
              />

            </div>
          ) : (
            <div className="space-y-5">
              <Section
                title={i18n.t('publish.sharedFiles')}
                hint={i18n.t('publish.sharedFilesHint')}
                emptyText={i18n.t('publish.emptySharedFiles')}
                groups={groupedSharedFiles}
                groupBy={prefs.groupBy !== 'none' && prefs.groupBy !== 'tag'}
                collapsed={prefs.collapsed}
                onToggleCollapsed={toggleCollapsed}
                renderRow={(f) => {
                  const shared = f as SharedFile;
                  const url = shared.url ? `${window.location.protocol}//${PUBLIC_HOST}${shared.url}` : '';
                  return (
                    <SharedFileRow
                      key={shared.id}
                      file={shared}
                      url={url}
                      justCopied={copiedKey === url}
                      busy={shareBusyId === shared.id}
                      onCopy={() => copyToClipboard(url)}
                      onRevoke={() => revokeSharedFile(shared)}
                    />
                  );
                }}
              />
            </div>
          )}
        </div>
      </div>
  );

  if (variant === 'embedded') return panel;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      {panel}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface GroupedItems<T> {
  key: string;
  label: string;
  items: T[];
}

/**
 * Bucket items by the chosen mode:
 *   - 'none'    → single "All" bucket (group UI stays hidden by Section)
 *   - 'project' → bucket by item.project, "미분류" at the end
 *   - 'tag'     → bucket by each tag (items with N tags appear in N buckets);
 *                  items with no tags fall into a single "태그 없음" bucket.
 *                  Note: items can show up multiple times in tag mode by
 *                  design — that's the user-requested behavior (a single site
 *                  can carry "client-acme" and "draft" tags simultaneously).
 * Within each bucket items sort by `sort`. Groups themselves sort alphabetically
 * with the "미분류"/"태그 없음" bucket pinned to the bottom.
 */
function groupAndSort<T extends { name?: string; fileName?: string; created_at: string; project?: string; tags?: string[] }>(
  items: T[],
  groupBy: GroupMode,
  sort: SortMode,
  projectDisplayMap: Record<string, string> = {},
): GroupedItems<T>[] {
  if (groupBy === 'none') {
    return [{
      key: '__all__',
      label: 'All',
      items: [...items].sort((a, b) => compareForSort(a, b, sort)),
    }];
  }

  const buckets = new Map<string, T[]>();
  const sentinel = groupBy === 'project' ? UNTRACKED_GROUP : UNTAGGED_GROUP;

  for (const item of items) {
    if (groupBy === 'project') {
      const key = item.project || sentinel;
      (buckets.get(key) || buckets.set(key, []).get(key)!).push(item);
    } else {
      // groupBy === 'tag' — fan-out: one entry per tag, or sentinel if untagged
      const tags = item.tags && item.tags.length > 0 ? item.tags : [sentinel];
      for (const t of tags) {
        (buckets.get(t) || buckets.set(t, []).get(t)!).push(item);
      }
    }
  }

  const named: GroupedItems<T>[] = [];
  let extra: GroupedItems<T> | null = null;
  for (const [key, arr] of buckets) {
    arr.sort((a, b) => compareForSort(a, b, sort));
    // Project mode: prefer DB-resolved Korean display name over folder ID.
    // Falls back to folder for unknown folders (project deleted, manifest
    // pre-promotion entries, etc.). Tag mode passes through verbatim.
    let label: string;
    if (key === UNTRACKED_GROUP) label = i18n.t('publish.untracked');
    else if (key === UNTAGGED_GROUP) label = i18n.t('publish.noTags');
    else if (groupBy === 'project') label = projectDisplayMap[key] || key;
    else label = key;
    const entry: GroupedItems<T> = { key, label, items: arr };
    if (key === UNTRACKED_GROUP || key === UNTAGGED_GROUP) extra = entry;
    else named.push(entry);
  }
  named.sort((a, b) => a.label.localeCompare(b.label));
  return extra ? [...named, extra] : named;
}

interface SectionProps<T> {
  title: string;
  hint: string;
  emptyText: string;
  groups: GroupedItems<T>[];
  groupBy: boolean;
  collapsed: string[];
  onToggleCollapsed: (key: string) => void;
  renderRow: (item: T) => React.ReactNode;
}

function Section<T>({ title, hint, emptyText, groups, groupBy, collapsed, onToggleCollapsed, renderRow }: SectionProps<T>) {
  const total = groups.reduce((sum, g) => sum + g.items.length, 0);
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[13px] font-semibold text-neutral-400 uppercase tracking-wider">{title}</span>
        <span className="text-[12px] text-neutral-600">{hint}</span>
        <span className="text-[12px] text-neutral-600">· {total}</span>
      </div>
      {total === 0 ? (
        <div className="text-center py-6 text-[14px] text-neutral-600 border border-dashed border-neutral-800 rounded-lg">
          {emptyText}
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map(group => {
            const isCollapsed = collapsed.includes(`${title}:${group.key}`);
            return (
              <div key={group.key}>
                {groupBy && (
                  <button
                    onClick={() => onToggleCollapsed(`${title}:${group.key}`)}
                    className="w-full flex items-center gap-1.5 mb-1 px-1 py-0.5 text-[13px] text-neutral-400 hover:text-neutral-200 group"
                  >
                    <svg
                      className={`w-3 h-3 transition-transform ${isCollapsed ? '-rotate-90' : ''}`}
                      fill="none" stroke="currentColor" viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                    <svg className="w-3 h-3 text-neutral-600 group-hover:text-neutral-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7a2 2 0 012-2h4l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                    </svg>
                    <span className={`font-medium ${group.key === UNTRACKED_GROUP ? 'text-neutral-500 italic' : 'text-neutral-300'}`}>
                      {group.label}
                    </span>
                    <span className="text-[12px] text-neutral-600">({group.items.length})</span>
                  </button>
                )}
                {!isCollapsed && (
                  <div className="publish-site-group flex flex-col rounded-md overflow-hidden border border-neutral-800/70 divide-y divide-neutral-800/70">
                    {group.items.map(item => renderRow(item))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface SiteRowProps {
  site: Site;
  url: string;
  justCopied: boolean;
  isGateway: boolean;
  statusDot: string;
  accessBadge: React.ReactNode;
  onCopy: () => void;
  // Visibility management — only meaningful when canEdit is true.
  canEdit?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  accessBusy?: boolean;
  // Tag editing (canEdit only). editingTags = whether the inline tag editor
  // is open for this row. allTags = workspace-wide tag suggestions.
  editingTags?: boolean;
  onStartEditTags?: () => void;
  onCancelEditTags?: () => void;
  onSetTags?: (next: string[]) => void;
  allTags?: Array<{ tag: string; count: number }>;
  // Archive (soft-delete) actions.
  onArchive?: () => void;
  onRestore?: () => void;
}

/**
 * Compact, single-line row. Optimized for scanning many sites at a glance:
 *   [☑ select?] [● status] name [access] [GW?] ... project date files [📋 copy]
 * The whole row is a link; interactive children stopPropagation+preventDefault.
 */
function SiteRow({
  site, url, justCopied, isGateway, statusDot, accessBadge, onCopy,
  canEdit, selected, onToggleSelect, accessBusy,
  editingTags, onStartEditTags, onCancelEditTags, onSetTags, allTags,
  onArchive, onRestore,
}: SiteRowProps) {
  const slug = site.slug || site.name;
  const slugDiffers = slug !== site.name;
  const stop = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); };
  const tags = site.tags || [];
  const isArchived = !!site.archived;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={`group flex items-center gap-2 px-2.5 py-1.5 transition-colors ${
        isArchived
          ? 'bg-neutral-900/30 opacity-60 hover:opacity-90'
          : selected
            ? 'tone-warning tone-bg-soft hover:opacity-90'
            : 'bg-neutral-900/40 hover:bg-neutral-800/60'
      }`}
      title={site.description || site.name}
    >
      {canEdit && (
        // Controlled checkbox inside an <a>. Toggle through onChange (the
        // canonical controlled-input handler — fires on native toggle), and
        // stopPropagation in onClick so the surrounding link doesn't navigate.
        // Earlier version used preventDefault in onClick which suppressed the
        // native toggle entirely, leaving onChange dormant and the visual state
        // a tick behind (the "next click flips the previous one" bug).
        <input
          type="checkbox"
          checked={!!selected}
          onChange={() => onToggleSelect?.()}
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 w-3 h-3 accent-primary-500 cursor-pointer"
          title={selected ? i18n.t('publish.clearSelection') : i18n.t('publish.selectMultiple')}
        />
      )}
      <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot}`} />
      {site.thumbnail_url ? (
        <img
          src={site.thumbnail_url}
          alt=""
          loading="lazy"
          className="publish-thumbnail w-12 h-7 rounded object-cover bg-neutral-800 border border-neutral-700/70 shrink-0"
          title={site.thumbnail_status === 'failed' ? i18n.t('publish.thumbnail.failed', { error: site.thumbnail_error || '' }) : i18n.t('publish.thumbnail.preview')}
        />
      ) : (
        <div className="publish-thumbnail w-12 h-7 rounded bg-neutral-800/70 border border-neutral-700/50 shrink-0" title={i18n.t('publish.thumbnail.none')} />
      )}
      <span className={`text-[15px] font-medium truncate min-w-0 ${
        isArchived
          ? 'text-neutral-500 line-through group-hover:text-neutral-300'
          : 'text-neutral-100 group-hover:text-white'
      }`}>
        {site.name}
      </span>
      {isArchived && (
        <span className="text-[11px] px-1 py-px rounded border bg-neutral-700/40 text-neutral-400 border-neutral-600 shrink-0">
          {i18n.t('publish.trash')}
        </span>
      )}
      {accessBadge}
      {isGateway && (
        <span className="text-[11px] px-1 py-px rounded bg-sky-500/15 text-sky-400 border border-sky-500/30 shrink-0">GW</span>
      )}

      {/* Tag chips — visible always, editable on click (canEdit only).
          Inline editor opens to the right with a free-form input + suggestion list. */}
      {canEdit && editingTags ? (
        <span className="flex items-center gap-1 shrink-0" onClick={stop}>
          <TagEditor
            current={tags}
            allTags={allTags || []}
            busy={!!accessBusy}
            onSave={(next) => onSetTags?.(next)}
            onCancel={() => onCancelEditTags?.()}
          />
        </span>
      ) : (
        <span className="flex items-center gap-1 shrink-0 max-w-[360px] overflow-hidden">
          {tags.slice(0, 4).map(t => (
            <span
              key={t}
              className="publish-tag-chip text-[12px] px-1.5 py-0.5 rounded-md border bg-violet-500/10 text-violet-200 border-violet-500/30"
              title={i18n.t('publish.tagTitle', { tag: t })}
            >
              {t}
            </span>
          ))}
          {tags.length > 4 && (
            <span className="text-sm text-neutral-400" title={tags.join(', ')}>
              +{tags.length - 4}
            </span>
          )}
          {canEdit && !isGateway && (
            <button
              onClick={(e) => { stop(e); onStartEditTags?.(); }}
              className="publish-tag-edit-button text-sm px-2 py-1 text-neutral-400 border border-violet-500/20 hover:text-violet-200 hover:bg-violet-500/15 hover:border-violet-500/40 rounded-md transition-colors"
              title={tags.length > 0 ? i18n.t('publish.editTags') : i18n.t('publish.addTags')}
            >
              {tags.length > 0 ? i18n.t('publish.tags') : i18n.t('publish.addTagShort')}
            </button>
          )}
        </span>
      )}

      <div className="flex-1" />

      {site.description && !isGateway && (
        <span className="hidden md:inline text-[13px] text-neutral-500 truncate max-w-[260px]" title={site.description}>
          {site.description}
        </span>
      )}
      {slugDiffers && (
        <span className="hidden lg:inline text-[12px] text-neutral-600 font-mono truncate max-w-[160px]" title={slug}>
          {slug}
        </span>
      )}
      {isGateway ? (
        <span className="text-[12px] text-sky-500 shrink-0">
          {site.deploy_target === 'azure-container-apps' ? '☁️ Azure' : '☁️ CF'}
        </span>
      ) : typeof site.files === 'number' ? (
        <span className="text-[12px] text-neutral-600 shrink-0 tabular-nums">{i18n.t('publish.fileCount', { count: site.files })}</span>
      ) : null}
      {site.created_at && (
        <span className="text-[12px] text-neutral-600 shrink-0 tabular-nums">
          {new Date(site.created_at).toLocaleDateString(i18n.resolvedLanguage || i18n.language, { month: '2-digit', day: '2-digit' })}
        </span>
      )}

      <button
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onCopy(); }}
        title={i18n.t('publish.copyUrl')}
        className={`shrink-0 p-1 rounded transition-colors ${
          justCopied
            ? 'tone-success tone-bg-soft tone-text'
            : 'text-neutral-600 hover:text-neutral-300 hover:bg-neutral-700/60'
        }`}
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          {justCopied ? (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          ) : (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          )}
        </svg>
      </button>
      {/* Archive (or Restore) — admin/operator only, hidden for Gateway-routed sites. */}
      {canEdit && !isGateway && (
        isArchived ? (
          <button
            onClick={(e) => { stop(e); onRestore?.(); }}
            disabled={accessBusy}
            title={i18n.t('publish.restoreHint')}
            className="tone-success shrink-0 p-1 rounded text-neutral-600 tone-hover transition-colors disabled:opacity-40"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
            </svg>
          </button>
        ) : (
          <button
            onClick={(e) => { stop(e); onArchive?.(); }}
            disabled={accessBusy}
            title={i18n.t('publish.archive.hint')}
            className="shrink-0 p-1 rounded text-neutral-600 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3" />
            </svg>
          </button>
        )
      )}
      <svg className="w-3 h-3 text-neutral-700 group-hover:text-neutral-400 shrink-0 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
      </svg>
    </a>
  );
}

// ── Inline tag editor ──
// Lightweight self-contained editor: text input + suggestion chips + save/cancel.
// Mirrors the access-tier inline picker pattern (clicking a row enters edit mode).
// Save sends the full set (replace semantics) so the user can both add and remove
// in one round trip; the suggestion list shows workspace-wide tags ranked by usage.
interface TagEditorProps {
  current: string[];
  allTags: Array<{ tag: string; count: number }>;
  busy: boolean;
  onSave: (next: string[]) => void;
  onCancel: () => void;
}
function TagEditor({ current, allTags, busy, onSave, onCancel }: TagEditorProps) {
  const [draft, setDraft] = useState<string[]>(current);
  const [input, setInput] = useState('');
  const TAG_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

  const tryAdd = (raw: string) => {
    const t = raw.trim().toLowerCase();
    if (!t || !TAG_RE.test(t)) return;
    if (draft.includes(t)) return;
    if (draft.length >= 16) return;
    setDraft([...draft, t]);
    setInput('');
  };
  const removeAt = (i: number) => setDraft(draft.filter((_, idx) => idx !== i));
  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
      e.preventDefault();
      tryAdd(input);
    } else if (e.key === 'Backspace' && input === '' && draft.length > 0) {
      e.preventDefault();
      removeAt(draft.length - 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };
  const suggestions = allTags
    .map(t => t.tag)
    .filter(t => !draft.includes(t))
    .filter(t => !input || t.includes(input.trim().toLowerCase()))
    .slice(0, 6);

  return (
    <span className="publish-tag-editor flex flex-wrap items-center gap-1.5 max-w-[720px] bg-neutral-950/70 border border-violet-500/40 rounded-lg px-2 py-1.5 shadow-lg shadow-black/20">
      {draft.map((t, i) => (
        <span
          key={t}
          className="flex items-center gap-1 text-sm px-2 py-1 rounded-md border bg-violet-500/15 text-violet-100 border-violet-500/40"
        >
          {t}
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); removeAt(i); }}
            className="text-violet-400 hover:text-red-400"
            title={i18n.t('publish.remove')}
          >×</button>
        </span>
      ))}
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKey}
        onClick={(e) => e.stopPropagation()}
        placeholder={draft.length === 0 ? 'tag (Enter)' : '+'}
        className="text-base bg-transparent text-neutral-100 border-none outline-none px-1 py-0.5 min-w-[120px] max-w-[220px] placeholder:text-neutral-500"
        autoFocus
      />
      {suggestions.length > 0 && (
        <span className="flex items-center gap-1 ml-1 pl-2 border-l border-neutral-700/60">
          {suggestions.map(s => (
            <button
              key={s}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); tryAdd(s); }}
              className="text-sm px-2 py-1 rounded-md border bg-neutral-800/70 text-neutral-300 border-neutral-600 hover:bg-violet-500/15 hover:text-violet-200 hover:border-violet-500/40"
              title={i18n.t('publish.addExistingTag', { tag: s })}
            >
              {s}
            </button>
          ))}
        </span>
      )}
      <button
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onSave(draft); }}
        disabled={busy}
        className="text-sm px-2.5 py-1 rounded-md bg-violet-600/40 text-violet-100 border border-violet-500/50 hover:bg-violet-600/60 disabled:opacity-40 ml-1"
        title={i18n.t('publish.saveEnter')}
      >{i18n.t('publish.save')}</button>
      <button
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onCancel(); }}
        disabled={busy}
        className="text-sm px-2 py-1 text-neutral-400 hover:text-neutral-200 disabled:opacity-40"
        title={i18n.t('publish.cancelEsc')}
      >✕</button>
    </span>
  );
}

interface AppRowProps {
  app: App;
  url: string;
  isExternal: boolean;
  isGateway: boolean;
  statusDot: string;
  accessBadge: React.ReactNode;
}

function timeLeft(expiresAt?: string): string {
  if (!expiresAt) return i18n.t('publish.expiry.none');
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return i18n.t('publish.expiry.expired');
  const days = Math.floor(ms / 86_400_000);
  if (days > 0) return i18n.t('publish.expiry.days', { count: days });
  const hours = Math.floor(ms / 3_600_000);
  if (hours > 0) return i18n.t('publish.expiry.hours', { count: hours });
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  return i18n.t('publish.expiry.minutes', { count: minutes });
}

interface SharedFileRowProps {
  file: SharedFile;
  url: string;
  justCopied: boolean;
  busy: boolean;
  onCopy: () => void;
  onRevoke: () => void;
}

function SharedFileRow({ file, url, justCopied, busy, onCopy, onRevoke }: SharedFileRowProps) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex items-center gap-2 px-2.5 py-1.5 bg-neutral-900/40 hover:bg-neutral-800/60 transition-colors"
      title={file.file_path}
    >
      <div className="w-1.5 h-1.5 rounded-full shrink-0 bg-sky-400" />
      <span className="flex h-7 w-12 shrink-0 items-center justify-center rounded border border-sky-500/20 bg-sky-500/10 text-[12px] font-semibold uppercase text-sky-300">
        {file.ext || i18n.t('publish.file')}
      </span>
      <span className="min-w-0 truncate text-[15px] font-medium text-neutral-100 group-hover:text-white">
        {file.fileName || file.name}
      </span>
      <span className="text-[11px] px-1 py-px rounded border bg-sky-500/10 text-sky-400 border-sky-500/20 shrink-0">
        {i18n.t('publish.shared')}
      </span>
      <div className="flex-1" />
      <span className="hidden md:inline text-[13px] text-neutral-500 truncate max-w-[320px]" title={file.file_path}>
        {file.file_path}
      </span>
      <span className="text-[12px] text-neutral-500 shrink-0 tabular-nums">
        {timeLeft(file.expires_at)}
      </span>
      {file.created_at && (
        <span className="text-[12px] text-neutral-600 shrink-0 tabular-nums">
          {new Date(file.created_at).toLocaleDateString(i18n.resolvedLanguage || i18n.language, { month: '2-digit', day: '2-digit' })}
        </span>
      )}
      <button
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onCopy(); }}
        title={i18n.t('publish.copyUrl')}
        className={`shrink-0 p-1 rounded transition-colors ${
          justCopied
            ? 'tone-success tone-bg-soft tone-text'
            : 'text-neutral-600 hover:text-neutral-300 hover:bg-neutral-700/60'
        }`}
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          {justCopied ? (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          ) : (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          )}
        </svg>
      </button>
      <button
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRevoke(); }}
        disabled={busy}
        title={i18n.t('publish.share.revokeTitle')}
        className="shrink-0 px-2 py-1 rounded border border-red-500/25 bg-red-500/10 text-[12px] text-red-300 hover:bg-red-500/20 hover:text-red-200 disabled:opacity-40 transition-colors"
      >
        {busy ? i18n.t('publish.share.revoking') : i18n.t('publish.share.revoke')}
      </button>
      <svg className="w-3 h-3 text-neutral-700 group-hover:text-neutral-400 shrink-0 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
      </svg>
    </a>
  );
}

function AppRow({ app, url, isExternal, isGateway, statusDot, accessBadge }: AppRowProps) {
  const statusColor = app.status === 'up'
    ? 'tone-success tone-text'
    : app.status === 'external'
      ? 'tone-info tone-text'
      : 'tone-danger tone-text';
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex items-center gap-2 px-2.5 py-1.5 bg-neutral-900/40 hover:bg-neutral-800/60 transition-colors"
      title={app.description || app.name}
    >
      <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot}`} />
      <span className="text-[15px] font-medium text-neutral-100 group-hover:text-white truncate min-w-0">
        {app.name}
      </span>
      {accessBadge}
      {isGateway && (
        <span className="text-[11px] px-1 py-px rounded bg-sky-500/15 text-sky-400 border border-sky-500/30 shrink-0">GW</span>
      )}

      <div className="flex-1" />

      {app.description && !isGateway && (
        <span className="hidden md:inline text-[13px] text-neutral-500 truncate max-w-[240px]" title={app.description}>
          {app.description}
        </span>
      )}
      {isExternal ? (
        <span className="text-[12px] text-sky-500 shrink-0">
          {app.deploy_target === 'azure-container-apps' ? '☁️ Azure' : '☁️ CF'}
        </span>
      ) : app.port ? (
        <span className="text-[12px] text-neutral-600 shrink-0 tabular-nums">:{app.port}</span>
      ) : null}
      <span className={`text-[12px] shrink-0 ${statusColor}`}>{app.status}</span>
      {app.statusCode && (
        <span className="text-[12px] text-neutral-600 shrink-0">HTTP {app.statusCode}</span>
      )}
      {app.created_at && (
        <span className="text-[12px] text-neutral-600 shrink-0 tabular-nums">
          {new Date(app.created_at).toLocaleDateString(i18n.resolvedLanguage || i18n.language, { month: '2-digit', day: '2-digit' })}
        </span>
      )}

      <svg className="w-3 h-3 text-neutral-700 group-hover:text-neutral-400 shrink-0 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
      </svg>
    </a>
  );
}
