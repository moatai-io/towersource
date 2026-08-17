// Owns: My Work unified file browser across Personal and AI teammate stores. See README.md.
import React from 'react';
import { useProjectStore } from '../../stores/project-store';
import { useSessionStore } from '../../stores/session-store';
import { useFileStore } from '../../stores/file-store';
import { useChatStore } from '../../stores/chat-store';
import { useConfirm, usePrompt } from '../../hooks/useDialog';
import { FILE_EXCHANGE_DRAG_TYPE, encodeExchangeDrag, transferFile, type ExchangeDestinationRef, type ExchangeSourceRef } from './fileExchange';
import { toastError, toastSuccess } from '../../utils/toast';
import { formatNamedItem } from '../../utils/korean-copy';

interface BrowserItem {
  id: string; name: string; source: ExchangeSourceRef;
  kind: 'note' | 'file' | 'folder'; sizeBytes?: number; modified?: string; openUri?: string;
}
type LocationKind = 'personal' | 'project';
type SortMode = 'name' | 'modified';
interface DestinationChoice {
  key: string;
  group: 'current' | 'personal' | 'project';
  label: string;
  description: string;
  icon: string;
  destination: ExchangeDestinationRef;
}

function authHeaders(): Record<string, string> { const token = localStorage.getItem('token'); return token ? { Authorization: `Bearer ${token}` } : {}; }
function formatBytes(bytes?: number): string { if (bytes == null) return '—'; if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`; return `${(bytes / 1024 ** 2).toFixed(1)} MB`; }
function formatDate(value?: string): string { const date = value ? new Date(value) : null; return !date || Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' }); }
async function readJson(url: string): Promise<any> { const res = await fetch(url, { headers: authHeaders() }); const data = await res.json().catch(() => ({})); if (!res.ok) throw new Error(data.error || '파일을 불러오지 못했습니다.'); return data; }

/** Deep file-browser surface: navigation, selection, storage actions, and transfer all stay inside this feature. */
export function FileExchangeSurface({ onOpenPersonalItem, personalOnly = false, unifiedPersonal = false }: { onOpenPersonalItem: (uri: string) => void; personalOnly?: boolean; unifiedPersonal?: boolean }) {
  const confirm = useConfirm();
  const prompt = usePrompt();
  const activeSessionId = useSessionStore(state => state.activeSessionId);
  const openSystemTab = useFileStore(state => state.openSystemTab);
  const allProjects = useProjectStore(state => state.projects);
  const projects = React.useMemo(() => allProjects.filter(project => !!project.rootPath && !project.archived), [allProjects]);
  const [location, setLocation] = React.useState<LocationKind>('personal');
  const [resourceId, setResourceId] = React.useState('');
  const [personalPath, setPersonalPath] = React.useState('');
  const [items, setItems] = React.useState<BrowserItem[]>([]);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(() => new Set());
  const [query, setQuery] = React.useState('');
  const [sortMode, setSortMode] = React.useState<SortMode>('name');
  const [destinationPickerOpen, setDestinationPickerOpen] = React.useState(false);
  const [destinationQuery, setDestinationQuery] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const sendButtonRef = React.useRef<HTMLButtonElement>(null);
  const closeDestinationPicker = React.useCallback((restoreFocus = false) => {
    setDestinationPickerOpen(false);
    setDestinationQuery('');
    if (restoreFocus) window.requestAnimationFrame(() => sendButtonRef.current?.focus());
  }, []);

  React.useEffect(() => {
    if (!destinationPickerOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDestinationPicker(true);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [closeDestinationPicker, destinationPickerOpen]);

  React.useEffect(() => {
    if (location === 'project' && !resourceId) setResourceId(projects[0]?.id || '');
  }, [location, projects, resourceId]);

  const load = React.useCallback(async () => {
    setLoading(true); setError(null); setSelectedIds(new Set());
    try {
      if (location === 'personal') {
        if (unifiedPersonal && !personalPath) {
          const [data, root] = await Promise.all([
            readJson('/api/personal-space/files'),
            readJson('/api/personal-space/files/directory?path='),
          ]);
          const systemRoots = new Set(['notes', 'files', 'archive']);
          const files = (data.files || []).map((item: any) => ({ id: item.id, name: item.name, source: { scope: 'personal', uri: item.uri }, kind: item.kind, sizeBytes: item.sizeBytes, modified: item.updatedAt, openUri: item.uri }));
          const folders = (root.entries || []).filter((item: any) => item.kind === 'directory' && !systemRoots.has(item.name)).map((item: any) => ({ id: item.id, name: item.name, source: { scope: 'personal', uri: item.uri }, kind: 'folder' as const, modified: item.updatedAt }));
          setItems([...folders, ...files]);
        } else {
          const data = await readJson(`/api/personal-space/files/directory?path=${encodeURIComponent(personalPath)}`);
          setItems((data.entries || []).filter((item: any) => personalPath || !['notes', 'files', 'archive'].includes(item.name)).map((item: any) => ({ id: item.id, name: item.name, source: { scope: 'personal', uri: item.uri }, kind: item.kind === 'directory' ? 'folder' : item.kind, sizeBytes: item.sizeBytes, modified: item.updatedAt, openUri: item.kind === 'directory' ? undefined : item.uri })));
        }
      } else {
        const project = projects.find(item => item.id === resourceId);
        const projectRootPath = project?.rootPath;
        if (!projectRootPath) return setItems([]);
        const data = await readJson(`/api/files/tree?path=${encodeURIComponent(projectRootPath)}`);
        setItems((data.entries || []).map((item: any) => ({ id: item.path, name: item.name, source: { scope: 'project', projectId: resourceId, relativePath: String(item.path).slice(projectRootPath.length).replace(/^\/+/, '') }, kind: item.isDirectory ? 'folder' : 'file', sizeBytes: item.size, modified: item.modified })));
      }
    } catch (cause) { setItems([]); setError(cause instanceof Error ? cause.message : '파일을 불러오지 못했습니다.'); }
    finally { setLoading(false); }
  }, [location, personalPath, projects, resourceId, unifiedPersonal]);
  React.useEffect(() => { void load(); }, [load]);

  const visibleItems = React.useMemo(() => items.filter(item => item.name.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => {
    if (a.kind === 'folder' && b.kind !== 'folder') return -1; if (a.kind !== 'folder' && b.kind === 'folder') return 1;
    return sortMode === 'modified' ? new Date(b.modified || 0).getTime() - new Date(a.modified || 0).getTime() : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  }), [items, query, sortMode]);
  const selectedItems = items.filter(item => selectedIds.has(item.id));
  const selected = selectedItems.length === 1 ? selectedItems[0] : null;

  const uploadPersonalFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true); setError(null);
    try {
      const targetDirectory = unifiedPersonal && !personalPath ? 'files' : personalPath || 'files';
      const form = new FormData(); form.append('directory', targetDirectory); Array.from(files).forEach(file => form.append('files', file));
      const res = await fetch('/api/personal-space/files/upload', { method: 'POST', headers: authHeaders(), body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 207) throw new Error(data.error || '업로드에 실패했습니다.');
      const saved = Array.isArray(data.files) ? data.files.length : 0; if (saved) toastSuccess(`${saved}개 파일을 저장했습니다.`); if (data.error) setError(`${saved}개 저장 후 일부 실패: ${data.error}`); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '업로드에 실패했습니다.'); } finally { setBusy(false); }
  };

  const createPersonalFolder = async () => {
    const name = await prompt({ title: '새 폴더', message: '폴더 이름을 입력하세요.', confirmLabel: '만들기' }); if (!name?.trim()) return;
    const target = personalPath ? `${personalPath}/${name.trim()}` : name.trim();
    const res = await fetch('/api/personal-space/files/create-directory', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ path: target }) });
    const data = await res.json().catch(() => ({})); if (!res.ok) return toastError(data.error || '폴더를 만들지 못했습니다.'); toastSuccess('폴더를 만들었습니다.'); await load();
  };

  const moveOrRenamePersonal = async () => {
    if (!selected || selected.kind === 'folder' || selected.source.scope !== 'personal') return;
    const currentPath = selected.source.uri.slice('personal://'.length);
    const nextPath = await prompt({ title: '이름 변경 또는 이동', message: '새 개인 폴더 경로를 입력하세요.', initialValue: currentPath, confirmLabel: '변경' }); if (!nextPath?.trim() || nextPath.trim() === currentPath) return;
    const res = await fetch('/api/personal-space/files/move', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ uri: selected.source.uri, nextPath: nextPath.trim() }) });
    const data = await res.json().catch(() => ({})); if (!res.ok) return toastError(data.error || '파일을 이동하지 못했습니다.'); toastSuccess('파일 위치를 변경했습니다.'); await load();
  };

  const archivePersonalSelection = async () => {
    const candidates = selectedItems.filter(item => item.kind !== 'folder' && item.source.scope === 'personal'); if (!candidates.length) return;
    if (!await confirm({ title: '개인 파일 보관', message: `${candidates.length}개 파일을 보관할까요?`, confirmLabel: '보관' })) return;
    for (const item of candidates) await fetch('/api/personal-space/files/archive', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ uri: (item.source as { scope: 'personal'; uri: string }).uri }) });
    toastSuccess(`${candidates.length}개 파일을 보관했습니다.`); await load();
  };

  const destinationChoices = React.useMemo<DestinationChoice[]>(() => {
    const choices: DestinationChoice[] = [];
    if (activeSessionId) choices.push({ key: `session:${activeSessionId}`, group: 'current', label: '현재 대화', description: '메시지에 첨부해 바로 사용', icon: '↗', destination: { scope: 'session', sessionId: activeSessionId } });
    if (location !== 'personal') choices.push({ key: 'personal', group: 'personal', label: '내 자료', description: '나만 볼 수 있는 파일로 저장', icon: '↓', destination: { scope: 'personal', relativeDirectory: 'files' } });
    for (const project of projects) {
      if (location === 'project' && project.id === resourceId) continue;
      choices.push({ key: `project:${project.id}`, group: 'project', label: project.agent?.displayName || project.name, description: 'AI 팀원 작업공간에 사본 저장', icon: project.agent?.face || '✦', destination: { scope: 'project', projectId: project.id, relativeDirectory: 'uploads' } });
    }
    return choices;
  }, [activeSessionId, location, projects, resourceId]);
  const filteredDestinations = React.useMemo(() => {
    const needle = destinationQuery.trim().toLowerCase();
    return needle ? destinationChoices.filter(choice => `${choice.label} ${choice.description}`.toLowerCase().includes(needle)) : destinationChoices;
  }, [destinationChoices, destinationQuery]);
  const openReceiptResult = (target: ExchangeDestinationRef, result: Record<string, unknown> | null) => {
    if (target.scope === 'personal' && typeof result?.uri === 'string') onOpenPersonalItem(result.uri);
    else if (target.scope === 'project') {
      const project = projects.find(item => item.id === target.projectId);
      if (project) openSystemTab('projectFiles', { refId: project.id, title: `${project.agent?.displayName || project.name} 홈`, icon: project.agent?.face || '✨' });
    }
  };
  const sendSelection = async (choice: DestinationChoice) => {
    const candidates = selectedItems.filter(item => item.kind !== 'folder');
    if (!candidates.length) return;
    closeDestinationPicker(); setBusy(true);
    try {
      let completed = 0; let lastResult: Record<string, unknown> | null = null;
      for (const item of candidates) {
        const receipt = await transferFile(item.source, choice.destination, async plan => confirm({ title: '파일 보내기', message: plan.confirmationMessage || `파일 ${formatNamedItem(item.name)}을 ${choice.label}에 보낼까요?`, confirmLabel: '보내기' }));
        if (receipt?.status === 'completed') {
          completed++; lastResult = receipt.result;
          if (choice.destination.scope === 'session') {
            const result = receipt.result as { attachmentId?: string; uri?: string; name?: string } | null;
            if (!result?.attachmentId || !result.uri) throw new Error('대화 첨부 정보를 받지 못했습니다.');
            useChatStore.getState().addAttachment({ id: `exchange-${result.attachmentId}`, type: 'file', label: result.name || item.name, content: result.uri, size: item.sizeBytes, sessionAttachmentId: result.attachmentId });
          }
        } else if (receipt) throw new Error(receipt.status === 'stale' ? '원본이 변경되었습니다.' : '현재 권한으로 전달할 수 없습니다.');
      }
      if (completed) {
        const verb = choice.destination.scope === 'session' ? '첨부했습니다.' : '복사했습니다.';
        toastSuccess(`${completed}개 파일을 ${choice.label}에 ${verb}`, choice.destination.scope === 'session' ? undefined : { action: { label: choice.destination.scope === 'project' ? '작업공간 열기' : '파일 열기', onClick: () => openReceiptResult(choice.destination, lastResult) } });
      }
    } catch (cause) { toastError(cause instanceof Error ? cause.message : '파일 전달에 실패했습니다.'); }
    finally { setBusy(false); }
  };

  const activateItem = (item: BrowserItem) => {
    if (item.kind === 'folder' && location === 'personal' && item.source.scope === 'personal') return setPersonalPath(item.source.uri.slice('personal://'.length));
    if (item.openUri) return onOpenPersonalItem(item.openUri);
    const source = item.source;
    if (source.scope === 'project') {
      const project = projects.find(candidate => candidate.id === source.projectId);
      if (project) openSystemTab('projectFiles', { refId: project.id, title: `${project.agent?.displayName || project.name} 홈`, icon: project.agent?.face || '✨' });
    }
  };

  const breadcrumbs = personalPath ? personalPath.split('/') : [];
  return <section aria-label={personalOnly ? '내 파일' : '내 파일과 팀의 저장소'} className="overflow-hidden rounded-2xl border border-surface-800 bg-surface-900/40">
    {!personalOnly && <div className="flex flex-col gap-3 border-b border-surface-800 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"><div><div className="text-[11px] font-semibold uppercase tracking-[.14em] text-emerald-300">FILE EXCHANGE</div><h2 className="mt-1 text-[18px] font-semibold text-surface-100">내 파일과 팀의 저장소</h2><p className="mt-1 text-[12px] text-surface-500">화면은 함께 보되 소유권과 저장 범위는 그대로 유지합니다.</p></div><div className="grid grid-cols-2 rounded-lg border border-surface-700 bg-surface-950 p-1">{([['personal','내 파일'],['project','AI 팀원']] as const).map(([value,label]) => <button key={value} onClick={() => { setLocation(value); setResourceId(''); }} className={`rounded-md px-3 py-1.5 text-[12px] font-semibold ${location === value ? 'bg-primary-500 text-white' : 'text-surface-400 hover:text-surface-100'}`}>{label}</button>)}</div></div>}
    <div className="flex flex-wrap items-center gap-2 border-b border-surface-800 px-4 py-3">{location === 'personal' ? <><button onClick={() => setPersonalPath('')} className="text-[12px] font-semibold text-primary-300">내 파일</button>{breadcrumbs.map((part,index) => <React.Fragment key={`${part}-${index}`}><span className="text-surface-700">/</span><button onClick={() => setPersonalPath(breadcrumbs.slice(0,index+1).join('/'))} className="text-[12px] text-surface-400 hover:text-surface-100">{part}</button></React.Fragment>)}<span className="flex-1"/><button onClick={() => void createPersonalFolder()} className="rounded-md border border-surface-700 px-2.5 py-1.5 text-[12px] text-surface-200">+ 폴더</button><label className="cursor-pointer rounded-md border border-surface-700 px-2.5 py-1.5 text-[12px] text-surface-200"><input type="file" multiple className="hidden" onChange={event => { void uploadPersonalFiles(event.target.files); event.currentTarget.value=''; }} />+ 파일</label></> : <select value={resourceId} onChange={event => setResourceId(event.target.value)} className="w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-[13px] text-surface-200 sm:max-w-sm">{projects.map(project => ({id:project.id,label:project.agent?.displayName||project.name})).map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select>}</div>
    <div className="flex flex-col gap-2 border-b border-surface-800 px-4 py-2 min-[420px]:flex-row"><input value={query} onChange={event => setQuery(event.target.value)} placeholder="파일 검색" className="min-w-0 flex-1 rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-[12px] text-surface-200"/><select value={sortMode} onChange={event => setSortMode(event.target.value as SortMode)} className="min-w-0 rounded-md border border-surface-700 bg-surface-950 px-2 py-2 text-[12px] text-surface-300"><option value="name">이름순</option><option value="modified">최근 수정순</option></select></div>
    <div className="min-h-56 min-w-0 overflow-x-auto" onDragOver={event => { if (location === 'personal' && event.dataTransfer.files.length) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }} onDrop={event => { if (location === 'personal' && event.dataTransfer.files.length) { event.preventDefault(); void uploadPersonalFiles(event.dataTransfer.files); } }}><div className="grid min-w-0 grid-cols-[32px_minmax(0,1fr)_72px] border-b border-surface-800 px-3 py-2 text-[11px] font-semibold text-surface-600 min-[560px]:grid-cols-[36px_minmax(0,1fr)_90px_100px_110px] min-[560px]:px-4"><span/><span>이름</span><span>종류</span><span className="hidden min-[560px]:block">크기</span><span className="hidden min-[560px]:block">수정</span></div>{loading ? <div className="p-10 text-center text-[13px] text-surface-500">불러오는 중…</div> : error ? <div className="p-8 text-center text-[13px] text-red-300">{error}</div> : visibleItems.length === 0 ? <div className="p-10 text-center text-[13px] text-surface-500">표시할 파일이 없습니다.</div> : visibleItems.map(item => <div key={`${item.source.scope}:${item.id}`} className={`grid min-w-0 grid-cols-[32px_minmax(0,1fr)_72px] items-center border-b border-surface-800/55 px-3 py-2 min-[560px]:grid-cols-[36px_minmax(0,1fr)_90px_100px_110px] min-[560px]:px-4 ${selectedIds.has(item.id) ? 'bg-primary-500/12' : 'hover:bg-surface-800/50'}`}><input type="checkbox" aria-label={`${item.name} 선택`} checked={selectedIds.has(item.id)} disabled={item.kind==='folder'} onChange={() => setSelectedIds(current => { const next=new Set(current); next.has(item.id)?next.delete(item.id):next.add(item.id); return next; })}/><button draggable={item.kind!=='folder'} onDragStart={event => { event.dataTransfer.setData(FILE_EXCHANGE_DRAG_TYPE, encodeExchangeDrag({version:1,source:item.source,name:item.name,sizeBytes:item.sizeBytes})); event.dataTransfer.effectAllowed='copy'; }} onDoubleClick={() => activateItem(item)} onClick={() => item.kind==='folder' ? activateItem(item) : setSelectedIds(new Set([item.id]))} className="min-w-0 truncate text-left text-[13px] font-medium text-surface-200">{item.kind==='folder'?'▸ ':''}{item.name}</button><span className="truncate text-[12px] text-surface-500">{item.kind==='folder'?'폴더':item.kind==='note'?'노트':'파일'}</span><span className="hidden text-[12px] text-surface-500 min-[560px]:block">{formatBytes(item.sizeBytes)}</span><span className="hidden text-[12px] text-surface-500 min-[560px]:block">{formatDate(item.modified)}</span></div>)}</div>
    <div className="relative flex flex-col gap-2 border-t border-surface-800 bg-surface-950/45 px-4 py-3 min-[760px]:flex-row min-[760px]:items-center"><span className="min-w-0 shrink-0 whitespace-normal break-keep text-[12px] leading-5 text-surface-400 min-[760px]:mr-auto min-[760px]:whitespace-nowrap">{selectedItems.length ? `${selectedItems.length}개 선택됨` : '파일을 선택하세요. 드래그해서 대화·AI 팀원으로 보낼 수도 있습니다.'}</span><div className="flex min-w-0 flex-wrap gap-2">{location==='personal' && <><button disabled={!selected || selected.kind==='folder'} onClick={() => void moveOrRenamePersonal()} className="min-w-0 rounded-md border border-surface-700 px-3 py-2 text-[12px] text-surface-300 disabled:opacity-35">이름·위치 변경</button><button disabled={!selectedItems.length} onClick={() => void archivePersonalSelection()} className="min-w-0 rounded-md border border-surface-700 px-3 py-2 text-[12px] text-surface-300 disabled:opacity-35">보관</button></>}<button ref={sendButtonRef} type="button" disabled={!selectedItems.length||busy} aria-haspopup="dialog" aria-expanded={destinationPickerOpen} onClick={() => destinationPickerOpen ? closeDestinationPicker() : setDestinationPickerOpen(true)} className="min-w-[108px] rounded-md bg-primary-500 px-3 py-2 text-[12px] font-semibold text-white disabled:opacity-40">{busy?'보내는 중…':'보내기…'}</button></div>
      {destinationPickerOpen && <><button type="button" aria-label="보내기 메뉴 닫기" className="fixed inset-0 z-40 cursor-default bg-black/20 min-[640px]:bg-transparent" onClick={() => closeDestinationPicker(true)} /><div role="dialog" aria-modal="true" aria-labelledby="file-destination-title" className="fixed inset-x-3 bottom-[max(12px,env(safe-area-inset-bottom))] z-50 max-h-[min(76vh,560px)] overflow-hidden rounded-2xl border border-surface-700 bg-surface-950 shadow-2xl min-[640px]:absolute min-[640px]:inset-x-auto min-[640px]:bottom-14 min-[640px]:right-4 min-[640px]:w-[360px]"><div className="border-b border-surface-800 px-4 py-3"><div className="flex items-center justify-between gap-3"><div><h3 id="file-destination-title" className="text-[14px] font-semibold text-surface-100">어디로 보낼까요?</h3><p className="mt-0.5 text-[11px] text-surface-500">원본은 그대로 두고 독립된 사본을 만듭니다.</p></div><button type="button" aria-label="닫기" onClick={() => closeDestinationPicker(true)} className="rounded-md px-2 py-1 text-surface-500 hover:bg-surface-800 hover:text-surface-200">✕</button></div><input autoFocus value={destinationQuery} onChange={event => setDestinationQuery(event.target.value)} placeholder="대화, AI 팀원 검색" className="mt-3 w-full rounded-lg border border-surface-700 bg-surface-900 px-3 py-2 text-[13px] text-surface-100 outline-none focus:border-primary-500" /></div><div className="max-h-[min(56vh,420px)] overflow-y-auto p-2">{filteredDestinations.length === 0 ? <p className="px-3 py-8 text-center text-[12px] text-surface-500">일치하는 보낼 곳이 없습니다.</p> : filteredDestinations.map((choice,index) => <React.Fragment key={choice.key}>{(index===0 || filteredDestinations[index-1].group!==choice.group) && <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[.12em] text-surface-600">{choice.group==='current'?'지금':choice.group==='personal'?'개인':'AI 팀원'}</div>}<button onClick={() => void sendSelection(choice)} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-surface-800/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-surface-700 bg-surface-900 text-[15px] text-surface-300">{choice.icon}</span><span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-semibold text-surface-100">{choice.label}</span><span className="mt-0.5 block truncate text-[11px] text-surface-500">{choice.description}</span></span><span className="text-surface-600">›</span></button></React.Fragment>)}</div></div></>}
    </div>
  </section>;
}
