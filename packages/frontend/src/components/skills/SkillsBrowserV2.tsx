import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import type { SkillMeta, SkillReadiness } from '@tower/shared';
import { useSettingsStore } from '../../stores/settings-store';
import { useProjectStore } from '../../stores/project-store';
import { getCurrentRole } from '../../utils/auth';
import { useSessionStore } from '../../stores/session-store';
import { toastError, toastSuccess } from '../../utils/toast';
import { remarkGfmPlugin } from '../../utils/markdown-plugins';

const API = '/api';

interface SkillDetail extends SkillMeta {
  content?: string;
  files?: string[];
}

interface SkillFileContent {
  path: string;
  content: string;
  binary?: boolean;
  truncated?: boolean;
  size?: number;
}

type DetailMode = 'preview' | 'code';
type View = 'dashboard' | 'catalog';

type OriginKey = 'tower' | 'company' | 'mine';
type CatalogFilter = 'all' | OriginKey;

type FilterKey = 'ready' | 'needs' | 'shared';
type SkillSortMode = 'recent' | 'name';

interface FilterDef {
  key: FilterKey;
  label: string;
  test: (s: SkillMeta) => boolean;
}

/**
 * SkillsBrowserV2 — teamskills-first 스킬 탐색 카탈로그.
 *
 * Owns: Skill 검색, 출처·준비 상태 확인, 문서 상세 보기.
 * Skill 사용 여부는 각 AI 팀원의 설정에서 관리하며 카탈로그는 실행 설정을 변경하지 않는다.
 *
 * Public API: `onSwitchToV1` (legacy 진입). Data API: `/api/skills`.
 * See: workspace/projects/tower/experiments/skill-registry-ui-issue-body.md
 *      workspace/projects/tower/published/skill-ui-v3-24a9b8/index.html (dashboard prototype)
 *      workspace/projects/tower/published/skill-ui-v2-87fa8f/index.html (V2 catalog prototype)
 */
export function SkillsBrowserV2({ onSwitchToV1: _onSwitchToV1 }: { onSwitchToV1: () => void }) {
  const setOpen = useSettingsStore((s) => s.setSkillsBrowserOpen);
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [readinessBySkill, setReadinessBySkill] = useState<Map<string, SkillReadiness>>(new Map());
  const [selected, setSelected] = useState<SkillDetail | null>(null);
  const [view, setView] = useState<View>('catalog');
  const [catalogFilter, setCatalogFilter] = useState<CatalogFilter>('all');
  const [search, setSearch] = useState('');
  const [activeFilters, setActiveFilters] = useState<Set<FilterKey>>(new Set());
  const [sortMode, setSortMode] = useState<SkillSortMode>('recent');
  const [showAllTiers, setShowAllTiers] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);


  const token = localStorage.getItem('token');
  const role = getCurrentRole();
  const isAdmin = role === 'admin';
  const currentUserName = useMemo(() => getCurrentUserName(), []);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const projects = useProjectStore((s) => s.projects);
  const activeSession = useMemo(() => sessions.find((s) => s.id === activeSessionId) ?? null, [sessions, activeSessionId]);
  const capabilityProjectId = useSettingsStore((s) => s.capabilityProjectId);
  const setCapabilityProjectId = useSettingsStore((s) => s.setCapabilityProjectId);
  const activeProjectId = capabilityProjectId || activeSession?.projectId || projects.find(p => !p.archived)?.id || null;
  const activeProjectName = projects.find(p => p.id === activeProjectId)?.name ?? null;

  const hdrs = useMemo(() => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }, [token]);

  const loadSkills = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const qs = activeProjectId ? `?projectId=${encodeURIComponent(activeProjectId)}` : '';
      const [projectResponse, readinessResponse] = await Promise.all([
        fetch(`${API}/skills${qs}`, { headers: hdrs }),
        fetch(`${API}/me/skill-readiness`, { headers: hdrs }),
      ]);

      // A stale/inaccessible project selection must not blank the organization
      // catalog. Fall back to the project-independent teamskills list and make
      // the reduced context visible instead of silently rendering zero rows.
      let skillsResponse = projectResponse;
      if (!projectResponse.ok && activeProjectId) {
        skillsResponse = await fetch(`${API}/skills`, { headers: hdrs });
        if (skillsResponse.ok) {
          setLoadError('선택한 프로젝트의 스킬은 불러오지 못해 팀 공용 카탈로그만 표시합니다.');
        }
      }
      if (!skillsResponse.ok) throw new Error(`skill catalog request failed: ${skillsResponse.status}`);

      const payload = await skillsResponse.json();
      setSkills(Array.isArray(payload) ? payload : []);
      const readiness: SkillReadiness[] = readinessResponse.ok ? await readinessResponse.json() : [];
      setReadinessBySkill(new Map(readiness.map((item) => [item.skillName, item])));
    } catch {
      setSkills([]);
      setReadinessBySkill(new Map());
      setLoadError('스킬 카탈로그를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      setLoading(false);
    }
  }, [activeProjectId, hdrs]);

  const loadDetail = useCallback(async (id: string) => {
    const r = await fetch(`${API}/skills/${id}`, { headers: hdrs });
    if (r.ok) setSelected(await r.json());
  }, [hdrs]);

  useEffect(() => { loadSkills(); }, [loadSkills]);

  const shareCompanySkill = useCallback(async () => {
    if (!selected || selected.scope !== 'project') return;
    const r = await fetch(`${API}/skills/${encodeURIComponent(selected.id)}/share-company`, {
      method: 'POST',
      headers: hdrs,
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      toastError(err.error || '회사 공용 등록에 실패했습니다.');
      return;
    }
    const result = await r.json();
    toastSuccess(result.created ? '회사 공용 스킬로 등록했습니다.' : '이미 회사 공용 스킬에 등록되어 있습니다.');
    await loadSkills();
  }, [hdrs, loadSkills, selected]);

  const copySkill = useCallback(async () => {
    if (!selected) return;
    if (!activeProjectId) {
      toastError('프로젝트에 연결된 세션에서만 프로젝트 스킬 사본을 만들 수 있습니다.');
      return;
    }
    const name = selected.name.trim();
    const content = selected.content?.trim() || `---\nname: ${name}\ndescription: ${selected.description || name}\nversion: 1.0.0\n---\n\n# /${name}\n`;
    const r = await fetch(`${API}/skills`, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({
        name,
        scope: 'project',
        projectId: activeProjectId,
        visibility: 'default',
        description: selected.description || name,
        category: selected.category || 'general',
        content,
      }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      toastError(err.error || '프로젝트 스킬 사본 생성에 실패했습니다. 같은 이름의 스킬이 이미 있을 수 있습니다.');
      return;
    }
    const copied = await r.json();
    await loadSkills();
    setCatalogFilter('mine');
    setView('catalog');
    await loadDetail(copied.id);
  }, [activeProjectId, hdrs, loadDetail, loadSkills, selected]);

  /**
   * 프로젝트 스킬 생성 — project-native filesystem source.
   * scope=project 로 현재 세션의 프로젝트 `skills/<name>/SKILL.md`에 저장한다.
   * DB-backed personal/project skill rows는 legacy-inert라 새로 만들지 않는다.
   */
  const createProjectSkill = useCallback(async (form: { name: string; description: string; category: string; content: string }): Promise<string | null> => {
    const name = form.name.trim();
    if (!name) return null;
    const description = form.description.trim() || name;
    const category = form.category.trim() || 'general';
    const body = form.content.trim().startsWith('---')
      ? form.content.trim()
      : `---\nname: ${name}\ndescription: ${description}\nversion: 1.0.0\ntags: [${category}]\n---\n\n# /${name}\n\n${form.content.trim() || description || '여기에 스킬 본문을 작성하세요.'}\n`;
    if (!activeProjectId) {
      toastError('프로젝트에 연결된 세션에서만 프로젝트 스킬을 만들 수 있습니다.');
      return null;
    }
    const r = await fetch(`${API}/skills`, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({
        name,
        scope: 'project',
        projectId: activeProjectId,
        visibility: 'default',
        description,
        category,
        content: body,
      }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      toastError(err.error || '프로젝트 스킬 생성에 실패했습니다.');
      return null;
    }
    const created = await r.json();
    await loadSkills();
    setCatalogFilter('mine');
    setView('catalog');
    if (created?.id) await loadDetail(created.id);
    return created?.id ?? null;
  }, [activeProjectId, hdrs, loadDetail, loadSkills]);

  // ── 필터 정의 (catalog) ────────────────────────────────────────────────
  const filterDefs = useMemo<FilterDef[]>(() => ([
    { key: 'ready', label: '바로 사용 가능', test: s => readinessBySkill.get(s.name)?.ready !== false },
    { key: 'needs', label: '준비 필요', test: s => readinessBySkill.get(s.name)?.ready === false },
    { key: 'shared', label: '공용', test: s => s.scope === 'company' || s.scope === 'project' },
  ]), [readinessBySkill]);

  // ── catalog 의 visible set (search + filter + tier + hidden + origin) ────
  const visibleCatalogSkills = useMemo(() => {
    const q = search.trim().toLowerCase();
    return skills.filter(s => {
      if (q && !`${s.name} ${s.description} ${s.category}`.toLowerCase().includes(q)) return false;
      if (s.scope === 'company' && !tierVisible(s.tier, isAdmin, showAllTiers)) return false;
      if (!q && s.visibility === 'hidden' && !(isAdmin && showHidden)) return false;
      if (catalogFilter !== 'all' && getOrigin(s, currentUserName) !== catalogFilter) return false;
      for (const f of activeFilters) {
        const def = filterDefs.find(x => x.key === f);
        if (def && !def.test(s)) return false;
      }
      return true;
    }).sort((a, b) => skillSort(a, b, sortMode));
  }, [activeFilters, catalogFilter, currentUserName, filterDefs, isAdmin, search, showAllTiers, showHidden, skills, sortMode]);

  const allActiveCount = skills.filter(skill => readinessBySkill.get(skill.name)?.ready !== false).length;

  // ── view 전환 helpers ────────────────────────────────────────────────
  const openCatalog = useCallback((filter: CatalogFilter, drawerId?: string) => {
    setCatalogFilter(filter);
    setView('catalog');
    if (drawerId) loadDetail(drawerId);
  }, [loadDetail]);

  const backToCatalog = useCallback(() => {
    setView('catalog');
    setSelected(null);
    setSearch('');
    setActiveFilters(new Set());
    setCatalogFilter('all');
  }, []);

  return (
    <div data-testid="skills-browser" className="fixed inset-0 z-[110] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setOpen(false)} />

      <div className="relative bg-surface-950 text-surface-100 border border-surface-800 rounded-xl shadow-2xl w-[96vw] max-w-[1680px] h-[94vh] flex flex-col overflow-hidden">
        <Header
          view={view}
          total={skills.length}
          activeCount={allActiveCount}
          resultCount={view === 'catalog' ? visibleCatalogSkills.length : undefined}
          catalogFilter={catalogFilter}
          isAdmin={isAdmin}
          showAllTiers={showAllTiers}
          showHidden={showHidden}
          onBackToCatalog={backToCatalog}
          onToggleAllTiers={() => setShowAllTiers(v => !v)}
          onToggleHidden={() => setShowHidden(v => !v)}
          onCreate={() => setShowCreate(true)}
          onClose={() => setOpen(false)}
        />

        <div className="flex-1 flex overflow-hidden bg-surface-950">
          {selected ? (
            <SkillDetailPage
              skill={selected}
              isActive={readinessBySkill.get(selected.name)?.ready !== false}
              onBack={() => setSelected(null)}
              onCopy={copySkill}
              onShareCompany={shareCompanySkill}
              readiness={readinessBySkill.get(selected.name)}
            />
          ) : view === 'dashboard' ? (
            <DashboardView
              skills={skills}
              currentUserName={currentUserName}
              loading={loading}
              onOpenCatalog={openCatalog}
              onCreate={() => setShowCreate(true)}
            />
          ) : (
            <CatalogView
              skills={visibleCatalogSkills}
              allSkills={skills}
              search={search}
              setSearch={setSearch}
              filterDefs={filterDefs}
              activeFilters={activeFilters}
              setActiveFilters={setActiveFilters}
              selectedId={undefined}
              onOpen={loadDetail}
              loading={loading}
              currentUserName={currentUserName}
              activeProjectId={activeProjectId}
              activeProjectName={activeProjectName}
              projects={projects}
              sortMode={sortMode}
              setSortMode={setSortMode}
              onProjectChange={setCapabilityProjectId}
              drawerOpen={false}
              readinessBySkill={readinessBySkill}
              loadError={loadError}
              onRetry={loadSkills}
            />
          )}
        </div>
      </div>

      {showCreate && (
        <CreateProjectSkillModal
          onClose={() => setShowCreate(false)}
          onCreate={createProjectSkill}
        />
      )}
    </div>
  );
}

// ── Header ──────────────────────────────────────────────────────────────
function Header(props: {
  view: View;
  total: number;
  activeCount: number;
  resultCount?: number;
  catalogFilter: CatalogFilter;
  isAdmin: boolean;
  showAllTiers: boolean;
  showHidden: boolean;
  onBackToCatalog: () => void;
  onToggleAllTiers: () => void;
  onToggleHidden: () => void;
  onCreate: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-5 py-3 border-b border-surface-800 bg-surface-900 shrink-0">
      <div className="flex items-center gap-2.5 min-w-0">
        {props.view === 'dashboard' && (
          <button onClick={props.onBackToCatalog}
            className="flex items-center gap-1 px-2 py-1 text-[13px] rounded-md border border-surface-700 text-surface-300 hover:text-surface-100 hover:border-surface-600 hover:bg-surface-800 transition-colors"
            title="스킬 목록으로 돌아가기">
            ← 스킬 목록
          </button>
        )}
        <div className="w-7 h-7 rounded-lg bg-violet-600/20 border border-violet-500/30 flex items-center justify-center">
          <svg className="w-4 h-4 text-violet-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-[17px] font-bold text-surface-100">Skill Catalog</h2>
            <span className="text-[12px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-700 dark:text-violet-300 border border-violet-500/30 font-mono uppercase tracking-wider">V2</span>
            {props.view === 'catalog' && props.catalogFilter !== 'all' && (
              <span className="text-[12px] px-1.5 py-0.5 rounded bg-surface-800 border border-surface-700 text-surface-100">
                {originLabel(props.catalogFilter)}
              </span>
            )}
          </div>
          <div className="text-[12px] text-surface-500">
            {props.view === 'catalog'
              ? `${props.resultCount ?? 0} / ${props.total} · 바로 사용 가능 ${props.activeCount}`
              : `${props.total}개 · 바로 사용 가능 ${props.activeCount}`}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button onClick={props.onCreate}
          className="px-2.5 py-1 text-[13px] rounded-md border border-sky-500/40 text-sky-700 dark:text-sky-300 bg-sky-500/10 hover:bg-sky-500/15 transition-colors font-medium"
          title="현재 프로젝트에 스킬 만들기">
          ＋ 프로젝트 스킬
        </button>
        {props.view === 'catalog' && props.isAdmin && (
          <>
            <button onClick={props.onToggleAllTiers} className={topButtonClass(props.showAllTiers)}>
              {props.showAllTiers ? '🔓 전체 tier' : '🔒 team만'}
            </button>
            <button onClick={props.onToggleHidden} className={topButtonClass(props.showHidden)}>
              {props.showHidden ? '👁 hidden 표시' : '👁‍🗨 hidden 숨김'}
            </button>
          </>
        )}
        <button onClick={props.onClose} className="p-1.5 text-surface-500 hover:text-surface-300 hover:bg-surface-800 rounded-lg transition-colors">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// ── DashboardView ──────────────────────────────────────────────────────
function DashboardView({ skills, currentUserName, loading, onOpenCatalog, onCreate }: {
  skills: SkillMeta[];
  currentUserName: string | null;
  loading: boolean;
  onOpenCatalog: (filter: CatalogFilter, drawerId?: string) => void;
  onCreate: () => void;
}) {
  const part = useMemo(() => partitionByOrigin(skills, currentUserName), [skills, currentUserName]);
  const newly = useMemo(() => newlyAdded(skills, 6), [skills]);
  const popular = useMemo(() => peerPopular(skills, 6), [skills]);
  const activeCount = skills.filter(isSkillActive).length;
  const categoryStats = useMemo(() => categoryCounts(skills), [skills]);

  if (loading) {
    return <main className="flex-1 flex items-center justify-center"><EmptyState title="능력 대시보드 불러오는 중…" /></main>;
  }

  return (
    <main className="flex-1 overflow-y-auto p-6 scrollbar-thin">

      {/* HERO — 내 능력 */}
      <section className="bg-gradient-to-br from-violet-500/8 via-surface-900 to-surface-900 border border-violet-500/20 rounded-2xl p-5 mb-5">
        <div className="flex items-center gap-5">
          <RingProgress value={activeCount} total={Math.max(skills.length, 1)} />
          <div className="flex-1 min-w-0">
            <div className="text-[14px] text-gray-400 mb-0.5">카탈로그에 등록된 Skill</div>
            <h2 className="text-[22px] font-bold text-gray-100 mb-2.5">{skills.length}개의 Skill을 탐색할 수 있어요</h2>
            <div className="flex flex-wrap gap-1.5">
              {categoryStats.slice(0, 6).map(([cat, on, total]) => (
                <div key={cat} className="px-2.5 py-1 text-[13px] rounded-full bg-surface-800/60 border border-surface-700">
                  <span className="text-gray-300">{cat}</span>
                  <span className="tone-success tone-text font-medium ml-1">{on}/{total}</span>
                </div>
              ))}
            </div>
          </div>
          <button
            onClick={onCreate}
            className="shrink-0 self-stretch px-4 flex flex-col items-center justify-center gap-1 rounded-xl border border-sky-500/30 bg-sky-500/5 text-sky-700 dark:text-sky-300 hover:bg-sky-500/10 hover:border-sky-500/50 transition-colors"
            title="현재 프로젝트에 스킬 만들기">
            <span className="text-3xl leading-none">＋</span>
            <span className="text-[13px] font-medium whitespace-nowrap">프로젝트 스킬 만들기</span>
          </button>
        </div>
      </section>

      {/* 이번 주 새로 추가됨 */}
      {newly.length > 0 && (
        <DashboardRow
          title={<><span className="tone-warning tone-text">🆕</span> 이번 주 새로 추가됨</>}
          hint={`최근 일주일 새로 추가된 ${newly.length}개`}
          items={newly.slice(0, 3)}
          accent="warning"
          onCardOpen={(id) => onOpenCatalog('all', id)}
        />
      )}

      {/* 동료가 자주 쓰는 */}
      {popular.length > 0 && (
        <DashboardRow
          title={<>🔥 동료가 자주 쓰는</>}
          hint="이번 주 팀에서 활발히 사용 중"
          items={popular.slice(0, 3)}
          accent="success"
          onCardOpen={(id) => onOpenCatalog('all', id)}
        />
      )}

      {/* 출처별 모아보기 */}
      <section className="mb-6">
        <div className="flex items-center mb-3 px-1">
          <h3 className="text-[16px] font-semibold text-gray-200 flex items-center gap-2">
            🗂 출처별 모아보기
            <span className="text-[13px] text-gray-500 font-normal">— 어디서 온 능력인지</span>
          </h3>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <OriginCard origin="tower"   skills={part.tower}   onOpenCatalog={onOpenCatalog} />
          <OriginCard origin="company" skills={part.company} onOpenCatalog={onOpenCatalog} />
          <OriginCard origin="mine"    skills={part.mine}    onOpenCatalog={onOpenCatalog} />
        </div>
      </section>

      {/* 전체 카탈로그 진입 */}
      <div className="text-center pt-1 pb-6">
        <button
          onClick={() => onOpenCatalog('all')}
          className="px-5 py-2.5 text-[15px] rounded-lg border border-surface-700 text-gray-300 hover:text-gray-100 hover:border-surface-600 transition-colors">
          → 전체 카탈로그 ({skills.length}) 보기
        </button>
        <div className="text-[12px] text-gray-600 mt-2">검색 · 필터 · 세부 메타</div>
      </div>
    </main>
  );
}

function DashboardRow({ title, hint, items, accent, onCardOpen }: {
  title: React.ReactNode;
  hint: string;
  items: SkillMeta[];
  accent: 'warning' | 'success';
  onCardOpen: (id: string) => void;
}) {
  return (
    <section className="mb-5">
      <div className="flex items-center justify-between mb-3 px-1">
        <h3 className="text-[16px] font-semibold text-gray-200 flex items-center gap-2">
          {title}
          <span className="text-[13px] text-gray-500 font-normal">— {hint}</span>
        </h3>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {items.map(s => (
          <CuratedCard key={s.id} skill={s} accent={accent} onOpen={onCardOpen} />
        ))}
      </div>
    </section>
  );
}

function CuratedCard({ skill, accent, onOpen }: {
  skill: SkillMeta;
  accent: 'warning' | 'success';
  onOpen: (id: string) => void;
}) {
  const active = isSkillActive(skill);
  const tone = accent === 'warning' ? 'tone-warning' : 'tone-success';
  const borderActive = `${tone} tone-border hover:opacity-90`;
  return (
    <button
      onClick={() => onOpen(skill.id)}
      className={`text-left bg-surface-900 border rounded-xl p-4 transition-all hover:-translate-y-px ${borderActive}`}
      title={skill.description}
    >
      <div className="flex items-start justify-between mb-2">
        <div className={`w-9 h-9 rounded-lg tone-pill ${tone} flex items-center justify-center text-lg shrink-0`}>
          {emojiForSkill(skill)}
        </div>
        <span className={`rounded-full border px-2 py-0.5 text-[11px] ${active ? 'border-emerald-500/30 text-emerald-700 dark:text-emerald-300' : 'border-surface-700 text-surface-500'}`}>{active ? '카탈로그' : '선택형'}</span>
      </div>
      <div className="font-mono text-[15px] text-gray-100 mb-1 truncate"><span className="text-violet-400/60">/</span>{skill.name}</div>
      <p className="text-[13px] text-gray-400 leading-relaxed line-clamp-2">{skill.description}</p>
    </button>
  );
}

function OriginCard({ origin, skills, onOpenCatalog }: {
  origin: OriginKey;
  skills: SkillMeta[];
  onOpenCatalog: (filter: CatalogFilter, drawerId?: string) => void;
}) {
  const total = skills.length;
  const on = skills.filter(isSkillActive).length;
  const meta = ORIGIN_META[origin];
  const previewSkills = skills.slice(0, 4);

  return (
    <div className={`bg-surface-900 border rounded-xl p-4 transition-colors ${meta.tone} ${meta.border} ${meta.borderHover}`}>
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2">
          <div className={`w-7 h-7 rounded-lg flex items-center justify-center text-[15px] ${meta.iconBg} border ${meta.iconBorder}`}>
            {meta.emoji}
          </div>
          <div className="text-[14px] font-semibold text-gray-200">{meta.label}</div>
        </div>
        <div className="text-right">
          <div className={`text-[20px] font-bold leading-none ${meta.numberColor}`}>{total}</div>
          <div className="text-[11px] text-gray-600 mt-0.5">{on} 기본 노출</div>
        </div>
      </div>
      <p className="text-[12px] text-gray-500 mb-3">{meta.subtitle}</p>

      {previewSkills.length === 0 ? (
        <div className="text-[13px] text-gray-600 mb-3 italic">아직 없음</div>
      ) : (
        <div className="space-y-1.5 text-[13px] font-mono mb-3">
          {previewSkills.map(s => (
            <button
              key={s.id}
              onClick={() => onOpenCatalog(origin, s.id)}
              className="flex items-center gap-1.5 w-full text-left hover:text-gray-100 transition-colors"
            >
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isSkillActive(s) ? 'tone-success tone-bg' : 'bg-gray-600'}`}></span>
              <span className={`truncate ${isSkillActive(s) ? 'text-gray-300' : 'text-gray-500'}`}>/{s.name}</span>
            </button>
          ))}
        </div>
      )}

      <button
        onClick={() => onOpenCatalog(origin)}
        className={`text-[13px] ${meta.linkColor} hover:underline`}
      >
        → {total}개 전체
      </button>
    </div>
  );
}

function RingProgress({ value, total }: { value: number; total: number }) {
  const pct = total > 0 ? value / total : 0;
  const circumference = 2 * Math.PI * 42;
  const offset = circumference * (1 - pct);
  return (
    <div className="relative w-24 h-24 shrink-0">
      <svg className="w-24 h-24 -rotate-90" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="6" />
        <circle cx="50" cy="50" r="42" fill="none" stroke="url(#ring-grad)" strokeWidth="6" strokeLinecap="round"
          strokeDasharray={circumference} strokeDashoffset={offset} />
        <defs>
          <linearGradient id="ring-grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#a78bfa" />
            <stop offset="100%" stopColor="#10b981" />
          </linearGradient>
        </defs>
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="text-[26px] font-bold text-gray-100 leading-none">{value}</div>
        <div className="text-[11px] text-gray-500 mt-0.5">/ {total}</div>
      </div>
    </div>
  );
}

// ── CatalogView ─────────────────────────────────────────────────────────
function CatalogView({ skills, allSkills, search, setSearch, filterDefs, activeFilters, setActiveFilters,
  selectedId, onOpen, loading, currentUserName, activeProjectId, activeProjectName,
  projects, sortMode, setSortMode, onProjectChange, drawerOpen, readinessBySkill, loadError, onRetry }: {
  skills: SkillMeta[];
  allSkills: SkillMeta[];
  search: string;
  setSearch: (s: string) => void;
  filterDefs: FilterDef[];
  activeFilters: Set<FilterKey>;
  setActiveFilters: React.Dispatch<React.SetStateAction<Set<FilterKey>>>;
  selectedId?: string;
  onOpen: (id: string) => void;
  loading: boolean;
  currentUserName: string | null;
  activeProjectId: string | null;
  activeProjectName: string | null;
  projects: ReturnType<typeof useProjectStore.getState>['projects'];
  sortMode: SkillSortMode;
  setSortMode: React.Dispatch<React.SetStateAction<SkillSortMode>>;
  onProjectChange: (projectId: string | null) => void;
  drawerOpen: boolean;
  readinessBySkill: Map<string, SkillReadiness>;
  loadError: string | null;
  onRetry: () => void;
}) {
  const active = skills.filter((skill) => readinessBySkill.get(skill.name)?.ready !== false);
  const inactive = skills.filter((skill) => readinessBySkill.get(skill.name)?.ready === false);

  return (
    <main className={`min-w-0 flex flex-col transition-all duration-200 ${drawerOpen ? 'w-1/2 border-r border-surface-800' : 'w-full'}`}>
      <div className="shrink-0 px-4 py-3 border-b border-surface-800 bg-surface-900 space-y-2.5">
        <div className="relative">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="스킬 이름·설명·카테고리 검색…"
            className="w-full bg-surface-950/80 border border-surface-700 rounded-lg pl-10 pr-3 py-2 text-[15px] text-surface-100 placeholder-surface-600 focus:border-violet-500/50 focus:outline-none"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={activeProjectId ?? ''}
            onChange={(e) => onProjectChange(e.target.value || null)}
            className="min-w-[220px] rounded-lg border border-surface-700 bg-surface-950/80 px-3 py-1.5 text-[13px] text-surface-100 outline-none focus:border-primary-500/60"
            title="스킬을 볼 프로젝트 선택"
          >
            <option value="">프로젝트 없음 · 공용만</option>
            {projects.filter(p => !p.archived).map(project => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
          <FilterBar
            filters={filterDefs}
            skills={allSkills}
            activeFilters={activeFilters}
            onToggle={(key) => setActiveFilters(prev => {
              const next = new Set(prev);
              if (next.has(key)) next.delete(key); else next.add(key);
              return next;
            })}
          />
          <SortBar sortMode={sortMode} setSortMode={setSortMode} />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 scrollbar-thin">
        <SkillStructureSummary skills={allSkills} activeProjectName={activeProjectName} readinessBySkill={readinessBySkill} />
        {loadError && <CatalogLoadNotice message={loadError} onRetry={onRetry} />}
        {loading ? (
          <EmptyState title="스킬을 불러오는 중…" />
        ) : skills.length === 0 ? (
          loadError ? (
            <EmptyState title="카탈로그를 표시할 수 없습니다" hint="다시 시도해도 계속 비어 있으면 스킬 소스와 프로젝트 접근 권한을 확인해 주세요." />
          ) : (
            <EmptyState title="조건에 맞는 스킬이 없습니다" hint="검색어 또는 필터를 줄여보세요." />
          )
        ) : (
          <div className="space-y-6 pb-10">
            <SkillListSection title="현재 프로젝트 · 바로 사용 가능" hint="이 팀원의 설정에서 사용 여부를 정할 수 있는 스킬" skills={active} compact={drawerOpen}
              selectedId={selectedId} currentUserName={currentUserName} readinessBySkill={readinessBySkill} onOpen={onOpen} />
            <SkillListSection title="준비 필요" hint="연결, 권한 또는 실행환경 준비가 필요한 대상" skills={inactive} muted compact={drawerOpen}
              selectedId={selectedId} currentUserName={currentUserName} readinessBySkill={readinessBySkill} onOpen={onOpen} />

          </div>
        )}
      </div>
    </main>
  );
}

function FilterBar({ filters, skills, activeFilters, onToggle }: {
  filters: FilterDef[];
  skills: SkillMeta[];
  activeFilters: Set<FilterKey>;
  onToggle: (key: FilterKey) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {filters.map(f => {
        const active = activeFilters.has(f.key);
        const count = skills.filter(f.test).length;
        return (
          <button
            key={f.key}
            onClick={() => onToggle(f.key)}
            className={`px-2.5 py-1 text-[13px] rounded-full border transition-colors ${active
              ? 'bg-violet-500/15 border-violet-500/50 text-violet-700 dark:text-violet-200'
              : 'bg-surface-800/50 border-surface-700 text-surface-500 hover:border-surface-600 hover:text-surface-100'}`}
          >
            {f.label} <span className="text-surface-600 dark:text-surface-500">{count}</span>
          </button>
        );
      })}
    </div>
  );
}

function SortBar({ sortMode, setSortMode }: {
  sortMode: SkillSortMode;
  setSortMode: React.Dispatch<React.SetStateAction<SkillSortMode>>;
}) {
  return (
    <div className="flex items-center gap-1.5 text-[12px] text-surface-500">
      <span>정렬</span>
      <button
        onClick={() => setSortMode('recent')}
        className={`px-2.5 py-1 text-[13px] rounded-full border transition-colors ${sortMode === 'recent' ? 'bg-primary-500/15 border-primary-500/45 text-primary-700 dark:text-primary-200' : 'bg-surface-800/50 border-surface-700 text-surface-500 hover:border-surface-600 hover:text-surface-100'}`}
      >최근 활용순</button>
      <button
        onClick={() => setSortMode('name')}
        className={`px-2.5 py-1 text-[13px] rounded-full border transition-colors ${sortMode === 'name' ? 'bg-primary-500/15 border-primary-500/45 text-primary-700 dark:text-primary-200' : 'bg-surface-800/50 border-surface-700 text-surface-500 hover:border-surface-600 hover:text-surface-100'}`}
      >이름순</button>
    </div>
  );
}

function SkillStructureSummary({ skills, activeProjectName, readinessBySkill }: {
  skills: SkillMeta[];
  activeProjectName: string | null;
  readinessBySkill: Map<string, SkillReadiness>;
}) {
  const projectCount = skills.filter(skill => skill.scope === 'project').length;
  const sharedCount = skills.filter(skill => skill.scope === 'company').length;
  const usableCount = skills.filter(skill => readinessBySkill.get(skill.name)?.ready !== false).length;
  return (
    <section className="mb-4 overflow-hidden rounded-xl border border-surface-800 bg-surface-900/70 shadow-sm" aria-label="현재 스킬 구조">
      <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
        <div className="min-w-0 sm:w-[240px]">
          <div className="text-[12px] font-semibold uppercase tracking-wider text-surface-500">현재 스킬 구조</div>
          <div className="mt-1 truncate text-[14px] font-semibold text-surface-100">{activeProjectName || '프로젝트 없음'}</div>
          <p className="mt-1 text-[12px] leading-relaxed text-surface-500">프로젝트와 팀의 스킬을 모아, 실제 사용 가능한 상태로 좁힙니다.</p>
        </div>
        <div className="grid min-w-0 flex-1 grid-cols-[1fr_auto_1fr_auto_1fr] items-stretch gap-2">
          <StructureStep label="프로젝트 스킬" value={projectCount} detail="이 프로젝트 전용" tone="sky" />
          <StructureOperator label="더하기" symbol="+" />
          <StructureStep label="팀 공용 스킬" value={sharedCount} detail="teamskills 카탈로그" tone="amber" />
          <StructureOperator label="필터링" symbol="→" />
          <StructureStep label="지금 사용 가능" value={usableCount} detail="연결 · 실행환경 준비" tone="green" />
        </div>
      </div>
    </section>
  );
}

function StructureStep({ label, value, detail, tone }: { label: string; value: number; detail: string; tone: 'sky' | 'amber' | 'green' }) {
  const toneClass = tone === 'sky'
    ? 'border-sky-500/30 bg-sky-500/8 text-sky-800 dark:text-sky-200'
    : tone === 'amber'
      ? 'border-amber-500/30 bg-amber-500/8 text-amber-800 dark:text-amber-200'
      : 'border-emerald-500/30 bg-emerald-500/8 text-emerald-800 dark:text-emerald-200';
  return (
    <div className={`min-w-0 rounded-lg border px-3 py-2 ${toneClass}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[12px] font-semibold">{label}</span>
        <strong className="text-[18px] leading-none">{value}</strong>
      </div>
      <div className="mt-1 truncate text-[11px] text-surface-500">{detail}</div>
    </div>
  );
}

function StructureOperator({ label, symbol }: { label: string; symbol: string }) {
  return <div className="flex items-center justify-center text-[16px] text-surface-500" aria-label={label}>{symbol}</div>;
}

function CatalogLoadNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="status" className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-[13px] text-amber-900 dark:text-amber-200">
      <span>{message}</span>
      <button onClick={onRetry} className="shrink-0 rounded-md border border-amber-500/35 px-2.5 py-1 font-semibold hover:bg-amber-500/10">다시 불러오기</button>
    </div>
  );
}

function SkillListSection({ title, hint, skills, muted, compact, selectedId, currentUserName, readinessBySkill, onOpen }: {
  title: string;
  hint: string;
  skills: SkillMeta[];
  muted?: boolean;
  compact?: boolean;
  selectedId?: string;
  currentUserName: string | null;
  readinessBySkill: Map<string, SkillReadiness>;
  onOpen: (id: string) => void;
}) {
  if (skills.length === 0) return null;
  return (
    <section>
      <div className="flex items-center gap-2 px-1 mb-2">
        <h3 className={`text-[13px] font-semibold uppercase tracking-wider ${muted ? 'text-surface-500' : 'tone-success tone-text'}`}>{title}</h3>
        <span className="text-[13px] text-surface-500">{skills.length}</span>
        <span className="text-[12px] text-surface-500">· {hint}</span>
      </div>
      <div className="overflow-hidden rounded-xl border border-surface-800 bg-surface-900/70 shadow-sm">
        <div className={`${skillListGridClass(compact)} gap-3 px-3 py-2 border-b border-surface-800 text-[11.5px] uppercase tracking-wider text-surface-500`}>
          <span>스킬</span>
          {!compact && <span>설명</span>}
          <span>공유</span>
          {!compact && <span>최근 활용 (30일)</span>}
          <span className="text-right">상태</span>
        </div>
        {skills.map(s => (
          <SkillListRow
            key={s.id}
            skill={s}
            origin={getOrigin(s, currentUserName)}
            selected={selectedId === s.id}
            compact={compact}
            readiness={readinessBySkill.get(s.name)}
            onOpen={onOpen}
          />
        ))}
      </div>
    </section>
  );
}

function SkillListRow({ skill, origin, selected, compact, readiness, onOpen }: {
  skill: SkillMeta;
  origin: OriginKey;
  selected: boolean;
  compact?: boolean;
  readiness?: SkillReadiness;
  onOpen: (id: string) => void;
}) {
  const active = readiness?.ready !== false;
  const meta = ORIGIN_META[origin];
  return (
    <button
      onClick={() => onOpen(skill.id)}
      className={`${skillListGridClass(compact)} w-full gap-3 items-center px-3 py-3 text-left border-b border-surface-800/70 last:border-b-0 transition-colors ${
        selected ? 'bg-violet-500/10' : 'hover:bg-surface-800/55'
      }`}
      title={skill.description}
    >
      <div className={`min-w-0 flex items-center gap-2 ${active ? '' : 'opacity-75 dark:opacity-55'}`}>
        <span className={`w-7 h-7 rounded-lg ${meta.iconBg} border ${meta.iconBorder} flex items-center justify-center text-[13px] shrink-0`}>
          {emojiForSkill(skill)}
        </span>
        <span className="font-mono text-[14px] text-surface-100 truncate"><span className="text-primary-500">/</span>{skill.name}</span>
        {skill.risk?.level === 'high' && <span className="text-[12px] text-red-400/90 shrink-0" title="고위험">⚠</span>}
      </div>
      {!compact && <p className={`text-[13px] text-surface-300 truncate ${active ? '' : 'opacity-70'}`}>{skill.description}</p>}
      <span className={`justify-self-start text-[11.5px] px-1.5 py-0.5 rounded border ${meta.tone} ${meta.chip}`}>{compact ? meta.emoji : meta.label}</span>
      {!compact && <span className="text-[12.5px] text-surface-500 truncate">{recentUsageLabel(skill)}</span>}
      <span className="justify-self-end flex items-center gap-2">
        {readiness ? <ReadinessBadge readiness={readiness} /> : <Badge tone="green">사용 가능</Badge>}
      </span>
    </button>
  );
}

function skillListGridClass(compact?: boolean): string {
  return compact
    ? 'grid grid-cols-[minmax(150px,1fr)_40px_48px]'
    : 'grid grid-cols-[minmax(180px,0.9fr)_minmax(240px,1.6fr)_110px_100px_72px]';
}

// ── Skill detail page ─────────────────────────────────────────────────
function SkillDetailPage({ skill, isActive, onBack, onCopy, onShareCompany, readiness }: {
  skill: SkillDetail;
  isActive: boolean;
  onBack: () => void;
  onCopy: () => void;
  onShareCompany: () => void;
  readiness?: SkillReadiness;
}) {
  return <SkillDetailContent skill={skill} isActive={isActive} onBack={onBack} onCopy={onCopy} onShareCompany={onShareCompany} readiness={readiness} />;
}

function SkillDetailContent({ skill, isActive, onBack, onCopy, onShareCompany, readiness }: {
  skill: SkillDetail;
  isActive: boolean;
  onBack: () => void;
  onCopy: () => void;
  onShareCompany: () => void;
  readiness?: SkillReadiness;
}) {
  const [mode, setMode] = useState<DetailMode>('preview');
  const fileOptions = useMemo(() => selectableSkillFiles(skill.files), [skill.files]);
  const [selectedFile, setSelectedFile] = useState('SKILL.md');
  const [fileContent, setFileContent] = useState<SkillFileContent | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const token = localStorage.getItem('token');

  useEffect(() => {
    setMode('preview');
    setSelectedFile(fileOptions.includes('SKILL.md') ? 'SKILL.md' : fileOptions[0] || 'SKILL.md');
    setFileContent(null);
  }, [skill.id, fileOptions]);

  useEffect(() => {
    if (selectedFile === 'SKILL.md') {
      setFileContent({ path: 'SKILL.md', content: skill.content || '', binary: false });
      return;
    }
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) h.Authorization = `Bearer ${token}`;
    let alive = true;
    setFileLoading(true);
    fetch(`${API}/skills/${encodeURIComponent(skill.id)}/file?path=${encodeURIComponent(selectedFile)}`, { headers: h })
      .then(r => r.ok ? r.json() : null)
      .then((data: SkillFileContent | null) => { if (alive) setFileContent(data); })
      .catch(() => { if (alive) setFileContent(null); })
      .finally(() => { if (alive) setFileLoading(false); });
    return () => { alive = false; };
  }, [selectedFile, skill.id, skill.content, token]);

  const displayContent = fileContent?.content ?? '';
  const previewable = !fileContent?.binary && isMarkdownLike(selectedFile);

  return (
    <main className="w-full flex flex-col bg-surface-950 overflow-hidden">
      <div className="shrink-0 p-5 border-b border-surface-800 bg-surface-900">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0 flex items-start gap-3">
            <button onClick={onBack} className="mt-1 px-3 py-1.5 text-[14px] rounded-lg border border-surface-700 text-surface-300 hover:bg-surface-800 transition-colors shrink-0" aria-label="목록으로 돌아가기">
              ← 목록
            </button>
            <div className="min-w-0">
              <h3 className="text-2xl font-bold text-surface-100 flex items-center gap-1 min-w-0">
                <span className="text-violet-400/70 font-mono">/</span>
                <span className="truncate">{skill.name}</span>
              </h3>
              <p className="text-[15px] text-surface-400 leading-relaxed mt-2 line-clamp-3">{skill.description}</p>
            </div>
          </div>
          <div className="shrink-0">
            <span className={`rounded-full border px-2.5 py-1 text-[12px] font-semibold ${isActive ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200' : 'border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200'}`}>{isActive ? '바로 사용 가능' : '준비 필요'}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <ScopeBadge scope={skill.scope} />
          <Badge>{skill.category || 'general'}</Badge>
          {skill.visibility && <VisibilityBadge visibility={skill.visibility} />}
          {isMineOnly(skill) && <Badge tone="sky">{(skill.access || []).join(', ')}</Badge>}
          {skill.risk?.level === 'high' && <Badge tone="red">⚠ 고위험</Badge>}
          {readiness && <ReadinessBadge readiness={readiness} />}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-5 scrollbar-thin space-y-4 w-full">
        <div className="flex items-center justify-between gap-3">
          <select
            value={selectedFile}
            onChange={e => setSelectedFile(e.target.value)}
            className="min-w-0 flex-1 bg-surface-800 border border-surface-700 rounded-lg px-3 py-2 text-[14px] text-surface-100 font-mono focus:border-violet-500/50 focus:outline-none"
          >
            {fileOptions.map(f => <option key={f} value={f}>{fileIcon(f)} {f}</option>)}
          </select>
          <div className="text-[12px] text-gray-600 flex-1">{skillFileCountLabel(skill.files)}</div>
          <div className="shrink-0 rounded-lg bg-surface-800 border border-surface-700 p-1 flex items-center gap-1">
            <button
              onClick={() => setMode('preview')}
              disabled={!previewable}
              className={`px-2.5 py-1 text-[13px] rounded-md transition-colors ${mode === 'preview' ? 'bg-surface-700 text-surface-100' : 'text-surface-500 hover:text-surface-300 disabled:opacity-30 disabled:hover:text-surface-500'}`}
              title="렌더링 보기"
            >👁 Preview</button>
            <button
              onClick={() => setMode('code')}
              className={`px-2.5 py-1 text-[13px] rounded-md transition-colors ${mode === 'code' ? 'bg-surface-700 text-surface-100' : 'text-surface-500 hover:text-surface-300'}`}
              title="원문 보기"
            >{'</>'} Code</button>
          </div>
        </div>

        <div className="grid grid-cols-[360px_minmax(0,1fr)] gap-5 items-start w-full">
          <SkillFileNavigator
            files={skill.files}
            selectedFile={selectedFile}
            onSelectFile={setSelectedFile}
          />
          <div className="bg-surface-950/40 border border-surface-700 rounded-xl overflow-hidden min-h-[56vh] shadow-sm">
            {fileLoading ? (
              <div className="h-48 flex items-center justify-center text-[14px] text-gray-500">파일을 불러오는 중…</div>
            ) : fileContent?.binary ? (
              <div className="h-48 flex flex-col items-center justify-center text-center text-gray-500">
                <div className="text-3xl mb-2">{fileIcon(selectedFile)}</div>
                <div className="text-[14px] text-gray-400">미리볼 수 없는 바이너리 파일입니다.</div>
                <div className="text-[12px] mt-1">{formatBytes(fileContent.size)} · Code 보기로 메타만 확인 가능</div>
              </div>
            ) : mode === 'preview' && previewable ? (
              <div className="p-8 prose prose-invert max-w-none prose-headings:text-surface-100 prose-h1:text-4xl prose-h2:text-2xl prose-p:text-surface-300 prose-p:leading-8 prose-li:text-surface-300 prose-li:leading-8 prose-code:text-primary-300 prose-code:bg-surface-900 prose-code:px-1 prose-code:rounded prose-pre:bg-surface-950 prose-pre:border prose-pre:border-surface-700 text-[16px]">
                <ReactMarkdown remarkPlugins={[remarkGfmPlugin]} rehypePlugins={[rehypeHighlight]}>
                  {stripFrontmatter(displayContent) || '_표시할 내용이 없습니다._'}
                </ReactMarkdown>
              </div>
            ) : (
              <pre className="m-0 p-5 text-[13px] leading-6 text-surface-300 overflow-auto max-h-[68vh] font-mono whitespace-pre-wrap"><code>{displayContent || (fileContent?.binary ? '바이너리 파일입니다.' : '표시할 내용이 없습니다.')}</code></pre>
            )}
          </div>
        </div>

        <MetaGrid skill={skill} />
      </div>

      <div className="shrink-0 px-5 py-3 border-t border-surface-800 bg-surface-900 flex items-center gap-2">
        {skill.scope === 'project' && (
          <button onClick={onShareCompany} className="px-3 py-1.5 text-[14px] rounded-md bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/20 transition-colors">
            회사 공용으로 등록
          </button>
        )}
        {(skill.scope === 'company' || skill.visibility === 'public') && (
          <button onClick={onCopy} className="px-3 py-1.5 text-[14px] rounded-md bg-sky-500/10 border border-sky-500/30 text-sky-300 hover:bg-sky-500/20 transition-colors">
            프로젝트 사본 만들기
          </button>
        )}
        <div className="flex-1" />
        <span className="text-[12px] text-gray-600">편집/삭제는 레거시 편집 화면에서 유지</span>
      </div>
    </main>
  );
}

function SkillFileNavigator({ files, selectedFile, onSelectFile }: {
  files?: string[];
  selectedFile: string;
  onSelectFile: (file: string) => void;
}) {
  const items = normalizeSkillFiles(files);
  return (
    <aside className="rounded-xl border border-surface-700 bg-surface-900/70 overflow-hidden max-h-[68vh] flex flex-col w-full">
      <div className="px-3 py-2 border-b border-surface-800 text-[12px] font-semibold uppercase tracking-wider text-surface-500">
        파일
      </div>
      <div className="overflow-y-auto p-1.5 scrollbar-thin">
        {items.map(item => item.kind === 'folder' ? (
          <div key={item.path} className="px-2 py-1.5 text-[12px] font-semibold text-surface-500 flex items-center gap-1.5" style={{ paddingLeft: 8 + item.depth * 14 }}>
            <span>▾</span><span className="truncate">{item.name}</span>
          </div>
        ) : (
          <button
            key={item.path}
            onClick={() => onSelectFile(item.path)}
            className={`w-full text-left rounded-md px-2 py-1.5 text-[13px] font-mono flex items-center gap-1.5 transition-colors ${
              selectedFile === item.path ? 'bg-primary-500/15 text-surface-100 border border-primary-500/25' : 'text-surface-300 hover:bg-surface-800 hover:text-surface-100'
            }`}
            style={{ paddingLeft: 8 + item.depth * 14 }}
            title={item.path}
          >
            <span className="shrink-0">{fileIcon(item.path)}</span>
            <span className="truncate">{item.name}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}

interface SkillFileNavItem {
  kind: 'folder' | 'file';
  path: string;
  name: string;
  depth: number;
}

function normalizeSkillFiles(files?: string[]): SkillFileNavItem[] {
  const paths = new Set<string>(['SKILL.md']);
  for (const f of files ?? []) if (f) paths.add(f);

  const folders = new Set<string>();
  const filePaths: string[] = [];
  for (const raw of paths) {
    const clean = raw.replace(/\/+$/, '');
    if (!clean) continue;
    if (raw.endsWith('/')) folders.add(clean);
    else {
      filePaths.push(clean);
      const parts = clean.split('/');
      for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
    }
  }

  const items: SkillFileNavItem[] = [];
  for (const folder of folders) {
    const parts = folder.split('/');
    items.push({ kind: 'folder', path: `${folder}/`, name: parts[parts.length - 1], depth: parts.length - 1 });
  }
  for (const file of filePaths) {
    const parts = file.split('/');
    items.push({ kind: 'file', path: file, name: parts[parts.length - 1], depth: parts.length - 1 });
  }

  return items.sort((a, b) => {
    if (a.path === 'SKILL.md') return -1;
    if (b.path === 'SKILL.md') return 1;
    const parentA = a.path.replace(/\/?[^/]+\/?$/, '');
    const parentB = b.path.replace(/\/?[^/]+\/?$/, '');
    if (parentA !== parentB) return parentA.localeCompare(parentB);
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function selectableSkillFiles(files?: string[]): string[] {
  return normalizeSkillFiles(files).filter((item): item is SkillFileNavItem & { kind: 'file' } => item.kind === 'file').map(item => item.path);
}

function skillFileCountLabel(files?: string[]): string {
  const selectable = selectableSkillFiles(files);
  const raw = files?.length ?? selectable.length;
  return raw === selectable.length ? `${selectable.length}개 파일` : `${selectable.length}개 파일 · 폴더 포함 ${raw}개`;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---[\s\S]*?---\n*/, '').trim();
}

function isMarkdownLike(file: string): boolean {
  return /(^|\/)(SKILL\.md|README\.md)$/i.test(file) || /\.(md|mdx|markdown|txt)$/i.test(file);
}

function fileIcon(file: string): string {
  if (/\/$/.test(file)) return '📁';
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(file)) return '🖼';
  if (/\.(ttf|otf|woff2?)$/i.test(file)) return '🔤';
  if (/\.(ts|tsx|js|jsx|py|sh|mjs|cjs)$/i.test(file)) return '⌘';
  if (/\.(json|ya?ml|toml)$/i.test(file)) return '◆';
  return '📄';
}

function formatBytes(size?: number): string {
  if (!size && size !== 0) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function MetaGrid({ skill }: { skill: SkillDetail }) {
  const items: [string, string][] = [
    ['구분', userFacingSkillOrigin(skill)],
    ['노출', skill.visibility || 'default'],
    ['접근', (skill.access || ['everyone']).join(', ')],
    ['소유', skill.ownership || skill.scope],
    ['작성자', skill.createdByName || '—'],
    ['프로젝트', skill.projectName || '—'],
    ['갱신', safeDate(skill.updatedAt)],
    ['위험', skill.risk?.level || 'low'],
    ...(skill.bundleDigest ? [['Bundle digest', skill.bundleDigest] as [string, string]] : []),
    ...(skill.sourceCommit ? [['Source commit', skill.sourceCommit] as [string, string]] : []),
  ];
  return (
    <div className="grid grid-cols-2 gap-2.5 text-[14px]">
      {items.map(([k, v]) => (
        <div key={k} className="bg-surface-800/40 border border-surface-700 rounded-md px-3 py-2 min-w-0">
          <div className="text-[12px] text-gray-500 uppercase tracking-wider mb-0.5">{k}</div>
          <div className="text-gray-300 truncate" title={v}>{v}</div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="h-full flex items-center justify-center text-center text-gray-500">
      <div>
        <div className="text-4xl mb-3">⚡</div>
        <div className="text-[15px] font-medium text-gray-400">{title}</div>
        {hint && <div className="text-[13px] mt-1 text-gray-600">{hint}</div>}
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────
function isSkillActive(s: SkillMeta): boolean {
  return s.userEnabled === true || (!!s.enabled && s.userEnabled !== false);
}

function isMineOnly(s: SkillMeta): boolean {
  return s.scope === 'project' || s.scope === 'personal' || !!s.access?.some(a => a.startsWith('user:'));
}

function isRecent(dateStr?: string | null): boolean {
  if (!dateStr) return false;
  const t = new Date(dateStr).getTime();
  return !Number.isNaN(t) && Date.now() - t < 1000 * 60 * 60 * 24 * 14;
}

function tierVisible(tier: string | undefined, isAdmin: boolean, showAll: boolean): boolean {
  if (showAll) return true;
  if (!isAdmin) return !tier || tier === 'team';
  return true;
}

function skillSort(a: SkillMeta, b: SkillMeta, mode: SkillSortMode = 'recent'): number {
  if (mode === 'recent') {
    const usageDiff = getRecentUsageCount(b) - getRecentUsageCount(a);
    if (usageDiff !== 0) return usageDiff;
    const lastA = getLastUsedAt(a) ? new Date(getLastUsedAt(a)!).getTime() : 0;
    const lastB = getLastUsedAt(b) ? new Date(getLastUsedAt(b)!).getTime() : 0;
    if (lastA !== lastB) return lastB - lastA;
  }
  const scopeRank: Record<string, number> = { personal: 0, project: 1, company: 2 };
  return (scopeRank[a.scope] ?? 9) - (scopeRank[b.scope] ?? 9) || a.name.localeCompare(b.name);
}

function recentUsageLabel(skill: SkillMeta): string {
  return `${getRecentUsageCount(skill)}회`;
}

function getRecentUsageCount(skill: SkillMeta): number {
  return Number((skill as SkillMeta & { recentUsageCount?: number }).recentUsageCount ?? 0);
}

function getUsageCount(skill: SkillMeta): number {
  return Number((skill as SkillMeta & { usageCount?: number }).usageCount ?? 0);
}

function getLastUsedAt(skill: SkillMeta): string | null {
  return (skill as SkillMeta & { lastUsedAt?: string | null }).lastUsedAt ?? null;
}

function safeDate(dateStr?: string | null): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

function topButtonClass(active: boolean): string {
  return active
    ? 'tone-pill tone-warning px-2.5 py-1 text-[13px] rounded-md transition-colors'
    : 'px-2.5 py-1 text-[13px] rounded-md border border-surface-700 text-surface-500 hover:text-surface-100 hover:border-surface-600 transition-colors';
}

/** Origin classification — metadata 자동 분류 (메타데이터 추가 입력 0). */
function getOrigin(s: SkillMeta, currentUserName: string | null): OriginKey {
  if (s.scope === 'project' || s.scope === 'personal') return 'mine';
  if (currentUserName && s.createdByName && s.createdByName === currentUserName && s.scope !== 'company') return 'mine';
  const sysish = s.source === 'bundled' || s.ownership === 'system';
  if (sysish) return 'tower';
  return 'company';
}

function partitionByOrigin(skills: SkillMeta[], currentUserName: string | null): Record<OriginKey, SkillMeta[]> {
  const out: Record<OriginKey, SkillMeta[]> = { tower: [], company: [], mine: [] };
  for (const s of skills) out[getOrigin(s, currentUserName)].push(s);
  for (const k of Object.keys(out) as OriginKey[]) out[k].sort((a, b) => skillSort(a, b, 'recent'));
  return out;
}

function newlyAdded(skills: SkillMeta[], days: number): SkillMeta[] {
  const cutoff = Date.now() - 1000 * 60 * 60 * 24 * days;
  return skills
    .filter(s => {
      const t = s.updatedAt ? new Date(s.updatedAt).getTime() : 0;
      return t > cutoff;
    })
    .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());
}

function peerPopular(skills: SkillMeta[], _max: number): SkillMeta[] {
  return skills
    .filter(s => s.scope === 'company' && s.visibility === 'default' && (!s.lifecycle || s.lifecycle === 'stable'))
    .sort((a, b) => skillSort(a, b, 'recent'));
}

function categoryCounts(skills: SkillMeta[]): [string, number, number][] {
  const m = new Map<string, { on: number; total: number }>();
  for (const s of skills) {
    const cat = s.category || 'general';
    if (!m.has(cat)) m.set(cat, { on: 0, total: 0 });
    const entry = m.get(cat)!;
    entry.total += 1;
    if (isSkillActive(s)) entry.on += 1;
  }
  return Array.from(m.entries())
    .map(([k, v]) => [k, v.on, v.total] as [string, number, number])
    .sort((a, b) => b[2] - a[2]);
}

function getCurrentUserName(): string | null {
  try {
    const raw = localStorage.getItem('user');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.username || parsed?.name || null;
  } catch {
    return null;
  }
}

function emojiForSkill(s: SkillMeta): string {
  const cat = (s.category || '').toLowerCase();
  if (cat.includes('dev') || cat.includes('code')) return '🛠';
  if (cat.includes('business')) return '💼';
  if (cat.includes('presentation') || cat.includes('design')) return '📊';
  if (cat.includes('docs') || cat.includes('document')) return '📚';
  if (cat.includes('ops') || cat.includes('tower') || cat.includes('admin')) return '🔧';
  if (cat.includes('meta')) return '🧠';
  if (cat.includes('browser') || cat.includes('web')) return '🌐';
  return '⚡';
}

function originLabel(o: CatalogFilter): string {
  if (o === 'all') return '전체';
  return ORIGIN_META[o].label;
}

function userFacingSkillOrigin(skill: SkillMeta): string {
  if (skill.scope === 'project') return '현재 프로젝트 스킬';
  if (skill.origin === 'tower' || skill.ownership === 'system' || skill.source === 'bundled') return 'Tower 제공 스킬';
  return '팀 공용 스킬';
}

const ORIGIN_META: Record<OriginKey, {
  label: string; emoji: string; subtitle: string;
  tone: string;
  border: string; borderHover: string;
  iconBg: string; iconBorder: string;
  numberColor: string; linkColor: string;
  chip: string;
}> = {
  tower: {
    label: 'Tower 제공 스킬',
    emoji: '⚡',
    subtitle: 'Tower가 기본 제공하고 업데이트하는 스킬',
    tone: 'tone-info',
    border: 'border-violet-500/25',
    borderHover: 'hover:border-violet-500/45',
    iconBg: 'bg-violet-500/10',
    iconBorder: 'border-violet-500/30',
    numberColor: 'text-violet-700 dark:text-violet-300',
    linkColor: 'text-violet-700 dark:text-violet-400',
    chip: 'bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/30',
  },
  company: {
    label: '팀 공용 스킬',
    emoji: '🏢',
    subtitle: '팀이 함께 검증하고 공유하는 스킬',
    tone: 'tone-warning',
    border: 'tone-border',
    borderHover: 'hover:opacity-90',
    iconBg: 'tone-bg-soft',
    iconBorder: 'tone-border',
    numberColor: 'tone-text',
    linkColor: 'tone-text',
    chip: 'tone-pill tone-warning',
  },
  mine: {
    label: '현재 프로젝트 스킬',
    emoji: '✋',
    subtitle: '이 프로젝트에서 만들고 바로 쓰는 스킬',
    tone: 'tone-info',
    border: 'border-sky-500/25',
    borderHover: 'hover:border-sky-500/45',
    iconBg: 'bg-sky-500/10',
    iconBorder: 'border-sky-500/30',
    numberColor: 'text-sky-700 dark:text-sky-300',
    linkColor: 'text-sky-700 dark:text-sky-400',
    chip: 'bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/30',
  },
};

// ── Badges (보존) ──────────────────────────────────────────────────────
function ScopeBadge({ scope }: { scope: SkillMeta['scope'] }) {
  const cls = scope === 'personal'
    ? 'tone-info'
    : scope === 'project'
      ? 'tone-success'
      : 'tone-warning';
  const label = scope === 'personal' ? '개인' : scope === 'project' ? '현재 프로젝트' : '팀 공용';
  return <span className={`tone-pill shrink-0 text-[11.5px] px-1.5 py-0.5 rounded ${cls}`}>{label}</span>;
}

function ReadinessBadge({ readiness, compact = false }: { readiness: SkillReadiness; compact?: boolean }) {
  if (readiness.ready) {
    return compact ? null : <Badge tone="green">바로 사용 가능</Badge>;
  }
  const credentialMissing = readiness.missing.length > 0;
  const label = credentialMissing ? '연결 필요' : '실행환경 준비 필요';
  const detail = credentialMissing
    ? readiness.missing.join(', ')
    : readiness.requirementNotes?.join(' · ') || '필요한 실행환경을 확인하세요.';
  return <Badge tone="amber"><span title={detail}>{compact ? '준비 필요' : label}</span></Badge>;
}

function Badge({ children, tone = 'gray' }: { children: React.ReactNode; tone?: 'gray' | 'sky' | 'red' | 'green' | 'amber' }) {
  const cls = tone === 'sky'
    ? 'bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/25'
    : tone === 'red'
      ? 'bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/25'
      : tone === 'green'
        ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/25'
        : tone === 'amber'
          ? 'bg-amber-500/10 text-amber-800 dark:text-amber-300 border-amber-500/30'
          : 'bg-surface-700/50 text-gray-400 border-surface-600/60';
  return <span className={`text-[11.5px] px-1.5 py-0.5 rounded border ${cls}`}>{children}</span>;
}

function VisibilityBadge({ visibility }: { visibility: NonNullable<SkillMeta['visibility']> }) {
  const tone = visibility === 'default' ? 'tone-success' :
    visibility === 'public' ? 'tone-info' :
    visibility === 'private' ? 'tone-warning' :
    'tone-muted';
  const label = visibility === 'default' || visibility === 'public' ? '공용' : visibility === 'private' ? '비공개' : visibility;
  return <span className={`tone-pill text-[11.5px] px-1.5 py-0.5 rounded ${tone}`}>{label}</span>;
}

/**
 * 프로젝트 스킬 생성 모달 — 현재 프로젝트 `skills/<name>/SKILL.md`에 저장한다.
 * 최소 입력: 이름 / 한 줄 설명 / 카테고리 / (선택) 본문 초안.
 * 본문 비우면 최소 SKILL.md 자동 생성. scripts/secret 필요 시 별도 파일로 확장한다.
 */
function CreateProjectSkillModal({ onClose, onCreate }: {
  onClose: () => void;
  onCreate: (form: { name: string; description: string; category: string; content: string }) => Promise<string | null>;
}) {
  const [form, setForm] = useState({ name: '', description: '', category: '', content: '' });
  const [busy, setBusy] = useState(false);
  const nameValid = /^[a-z0-9][a-z0-9-]{0,63}$/.test(form.name.trim()) && !form.name.trim().endsWith('-') && !form.name.trim().includes('--');

  const submit = async () => {
    if (!nameValid || busy) return;
    setBusy(true);
    const id = await onCreate(form);
    setBusy(false);
    if (id) onClose();
  };

  return (
    <div className="absolute inset-0 z-[120] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-surface-900 border border-surface-700 rounded-xl shadow-2xl w-full max-w-md flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-surface-800">
          <div className="flex items-center gap-2">
            <span className="text-sky-700 dark:text-sky-300 text-lg">✋</span>
            <h3 className="text-[16px] font-bold text-surface-100">프로젝트 스킬 만들기</h3>
            <span className="text-[12px] px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-700 dark:text-sky-300 border border-sky-500/30">프로젝트 사용</span>
          </div>
          <button onClick={onClose} className="p-1.5 text-gray-500 hover:text-gray-300 hover:bg-surface-800 rounded-lg transition-colors" aria-label="닫기">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-5 space-y-3.5">
          <div>
            <label className="block text-[13px] text-gray-400 mb-1">스킬 이름 <span className="text-gray-600">(소문자·숫자·하이픈)</span></label>
            <div className="flex items-center gap-1.5">
              <span className="text-violet-400/60 font-mono text-[16px]">/</span>
              <input
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="youtube-transcript"
                autoFocus
                className="flex-1 bg-surface-800/60 border border-surface-700 rounded-lg px-3 py-2 text-[15px] text-gray-200 placeholder-gray-600 font-mono focus:border-sky-500/50 focus:outline-none"
              />
            </div>
            {form.name.trim() && !nameValid && (
              <p className="tone-warning tone-text text-[12px] opacity-80 mt-1">소문자/숫자로 시작, 소문자·숫자·단일 하이픈만 사용하세요. 하이픈으로 끝나거나 연속 하이픈은 안 됩니다.</p>
            )}
          </div>

          <div>
            <label className="block text-[13px] text-gray-400 mb-1">한 줄 설명 <span className="text-gray-600">(이 스킬이 무슨 일을 하나)</span></label>
            <input
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="YouTube URL을 transcript 분석 브리프로 바꾼다."
              className="w-full bg-surface-800/60 border border-surface-700 rounded-lg px-3 py-2 text-[15px] text-gray-200 placeholder-gray-600 focus:border-sky-500/50 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-[13px] text-gray-400 mb-1">카테고리 <span className="text-gray-600">(선택)</span></label>
            <input
              value={form.category}
              onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
              placeholder="docs / dev / business …"
              className="w-full bg-surface-800/60 border border-surface-700 rounded-lg px-3 py-2 text-[15px] text-gray-200 placeholder-gray-600 focus:border-sky-500/50 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-[13px] text-gray-400 mb-1">본문 초안 <span className="text-gray-600">(비우면 최소 SKILL.md 자동 생성)</span></label>
            <textarea
              value={form.content}
              onChange={e => setForm(f => ({ ...f, content: e.target.value }))}
              rows={5}
              placeholder="언제 이 스킬을 쓰는지, 어떻게 동작하는지 자유롭게…"
              className="w-full bg-surface-800/60 border border-surface-700 rounded-lg px-3 py-2 text-[14px] text-gray-200 placeholder-gray-600 font-mono resize-y focus:border-sky-500/50 focus:outline-none"
            />
          </div>

          <p className="text-[12px] text-gray-500 leading-relaxed bg-surface-800/40 border border-surface-700 rounded-lg px-3 py-2">
            현재 프로젝트의 <span className="text-sky-700 dark:text-sky-300 font-mono">skills/{form.name.trim() || '스킬이름'}/SKILL.md</span>로 저장됩니다. 저장 후 다음 요청부터 <span className="text-sky-700 dark:text-sky-300 font-mono">/{form.name.trim() || '스킬이름'}</span> 후보로 사용할 수 있어요.
            스크립트·시크릿·여러 파일이 필요하면 같은 스킬 폴더 안에 추가하세요.
          </p>
        </div>

        <div className="px-5 py-3 border-t border-surface-800 flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-[14px] text-gray-400 hover:text-gray-200">취소</button>
          <button
            onClick={submit}
            disabled={!nameValid || busy}
            className={`px-5 py-2 text-[14px] font-medium rounded-lg transition-colors ${
              nameValid && !busy
                ? 'bg-sky-600 text-white hover:bg-sky-500'
                : 'bg-surface-700 text-gray-500 cursor-not-allowed'
            }`}>
            {busy ? '만드는 중…' : '＋ 프로젝트 스킬 만들기'}
          </button>
        </div>
      </div>
    </div>
  );
}
