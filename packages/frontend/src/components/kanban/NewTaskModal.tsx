import { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSessionStore } from '../../stores/session-store';
import { useProjectStore } from '../../stores/project-store';
import { getEngineFromModel, useModelStore } from '../../stores/model-store';
import type { TaskMeta } from '../../stores/kanban-store';

// Engine + model are independent (column added 2026-05-17, migration 058).
// The Pi engine now fronts Tower's AI Router models (Smartest/Smart via LiteLLM),
// while still retaining full-VM debug paths for direct providers.
// See: workspace/decisions/2026-05-17-pi-claude-parity-roadmap.md (W2)
const ENGINE_OPTIONS = [
  { id: 'claude', name: 'Claude (Max 구독)' },
  { id: 'pi',     name: 'AI Router' },
];

const WORKFLOW_OPTIONS = [
  { id: 'auto', name: 'Auto', desc: 'Agent decides' },
  { id: 'simple', name: 'Simple', desc: 'No code' },
  { id: 'default', name: 'Default', desc: 'Light code' },
  { id: 'feature', name: 'Feature', desc: 'Worktree' },
  { id: 'big_task', name: 'Big Task', desc: 'Decompose' },
];

// New tasks report through Notification Hub. Legacy channel/kakao/all/default
// policies remain readable for old rows but are normalized when edited.
const REPORT_POLICY_OPTIONS = [
  { id: 'silent', name: '🔕 조용히' },
  { id: 'notification', name: '🔔 알림으로 보고' },
];

interface NewTaskModalProps {
  onClose: () => void;
  onCreated: (task: TaskMeta) => void;
  /** If provided, modal becomes an edit form for this task */
  editTask?: TaskMeta;
  /** Project ID to associate the task with (for project-level visibility) */
  projectId?: string | null;
  /** Current board filter project ID — used to pre-select project in create mode */
  filterProjectId?: string | null;
}

/* ── Dropdown: styled select ── */
function Dropdown({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { id: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const selected = options.find((o) => o.id === value);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2 text-base bg-surface-800 border border-surface-700 rounded-lg text-gray-200 hover:border-surface-600 focus:outline-none focus:ring-1 focus:ring-blue-500 transition-colors cursor-pointer"
      >
        <span>{selected?.name || value}</span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          className={`text-gray-500 transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute z-50 w-full mt-1 bg-surface-800 border border-surface-700 rounded-lg shadow-xl overflow-hidden">
          {options.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => {
                onChange(opt.id);
                setOpen(false);
              }}
              className={`w-full text-left px-3 py-2 text-base hover:bg-surface-700 transition-colors flex items-center gap-2 ${
                opt.id === value ? 'text-blue-400 bg-surface-750' : 'text-gray-300'
              }`}
            >
              {opt.id === value && (
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
                </svg>
              )}
              <span className={opt.id === value ? '' : 'ml-5'}>{opt.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function NewTaskModal({ onClose, onCreated, editTask, projectId, filterProjectId }: NewTaskModalProps) {
  const { t } = useTranslation('kanban');
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const allProjects = useProjectStore((s) => s.projects);
  const claudeModels = useModelStore((s) => s.availableModels);
  const piModels = useModelStore((s) => s.piModels);
  const defaults = useModelStore((s) => s.defaults);
  const isEditing = !!editTask;

  const modelsByEngine = useMemo<Record<string, { id: string; name: string }[]>>(() => ({
    claude: claudeModels.map((m) => ({ id: m.id, name: m.name })),
    pi: piModels.map((m) => ({ id: m.id.replace(/^pi:/, ''), name: m.name })),
  }), [claudeModels, piModels]);

  const defaultTaskEngine = getEngineFromModel(defaults.ai_task);

  const defaultModelByEngine = useMemo<Record<string, string>>(() => ({
    claude: defaults.ai_task.startsWith('claude-') ? defaults.ai_task : (claudeModels[0]?.id || ''),
    pi: defaults.ai_task.startsWith('pi:') ? defaults.ai_task.slice(3) : (piModels[0]?.id.replace(/^pi:/, '') || 'litellm-responses/mini'),
  }), [defaults.ai_task, claudeModels, piModels]);

  const resolveInitialProject = () => {
    if (editTask?.projectId) return editTask.projectId;
    if (filterProjectId) return filterProjectId;
    if (projectId) return projectId;
    return '';
  };

  const [title, setTitle] = useState(editTask?.title || '');
  const [description, setDescription] = useState(editTask?.description || '');
  const [selectedProjectId, setSelectedProjectId] = useState<string>(resolveInitialProject());
  const [cwd, setCwd] = useState(editTask?.cwd || '');
  const [engine, setEngine] = useState<string>((editTask as any)?.engine || defaultTaskEngine);
  const [model, setModel] = useState<string>(
    editTask?.model || defaultModelByEngine[((editTask as any)?.engine || defaultTaskEngine)]
  );
  const [workflow, setWorkflow] = useState<string>(editTask?.workflow || 'auto');
  // UI-created tasks default to silent. Edit mode keeps whatever the task already had
  // (including 'default' for legacy rows), so opening an old recurring task in the
  // edit modal won't silently flip it off.
  const [reportPolicy, setReportPolicy] = useState<string>(
    (editTask as any)?.reportPolicy === 'silent' ? 'silent' : 'notification'
  );
  const [submitting, setSubmitting] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<{ name: string; path: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeProjects = useMemo(() => allProjects.filter(p => !p.archived), [allProjects]);

  // Auto-set cwd from selected project's rootPath
  useEffect(() => {
    if (selectedProjectId && !isEditing) {
      const proj = allProjects.find(p => p.id === selectedProjectId);
      if (proj?.rootPath) {
        setCwd(proj.rootPath);
      }
    }
  }, [selectedProjectId, allProjects, isEditing]);

  // If no cwd yet (no project selected), fall back to active session
  useEffect(() => {
    if (!cwd && activeSession?.cwd && !selectedProjectId) {
      setCwd(activeSession.cwd);
    }
  }, [activeSession, cwd, selectedProjectId]);

  const handleFileUpload = async (fileList: FileList) => {
    if (fileList.length === 0) return;
    setUploading(true);
    const formData = new FormData();
    for (const file of Array.from(fileList)) {
      formData.append('files', file);
    }
    try {
      const token = localStorage.getItem('token');
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch('/api/files/chat-upload', { method: 'POST', headers, body: formData });
      const data = await res.json();
      if (res.ok) {
        const ok = (data.results || []).filter((r: any) => !r.error);
        setAttachedFiles((prev) => [...prev, ...ok.map((r: any) => ({ name: r.name, path: r.path }))]);
      }
    } catch (err) {
      console.error('File upload failed:', err);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Determine effective cwd: from project rootPath or manual input
  const effectiveCwd = useMemo(() => {
    if (cwd.trim()) return cwd.trim();
    if (selectedProjectId) {
      const proj = allProjects.find(p => p.id === selectedProjectId);
      if (proj?.rootPath) return proj.rootPath;
    }
    return activeSession?.cwd || '';
  }, [cwd, selectedProjectId, allProjects, activeSession]);

  // Check if creating in a different project than filter
  const isDifferentFromFilter = !isEditing && filterProjectId && selectedProjectId && filterProjectId !== selectedProjectId;

  const handleSubmit = async () => {
    if (!title.trim() || !effectiveCwd) return;
    setSubmitting(true);
    try {
      // Append file references to description
      let fullDescription = description.trim();
      if (attachedFiles.length > 0) {
        const fileRefs = attachedFiles.map((f) => `[file: ${f.path}]`).join('\n');
        fullDescription = fullDescription
          ? `${fullDescription}\n\n## Attached Files\n${fileRefs}`
          : `## Attached Files\n${fileRefs}`;
      }
      const token = localStorage.getItem('token');

      if (isEditing && editTask) {
        // PATCH existing task
        const res = await fetch(`/api/tasks/${editTask.id}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            title: title.trim(),
            description: fullDescription,
            cwd: effectiveCwd,
            engine,
            model,
            workflow,
            projectId: selectedProjectId || undefined,
            reportPolicy,
          }),
        });
        if (res.ok) {
          const updated = await res.json();
          onCreated(updated);
        }
      } else {
        // POST new task
        const res = await fetch('/api/tasks', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            title: title.trim(),
            description: fullDescription,
            cwd: effectiveCwd,
            engine,
            model,
            workflow,
            projectId: selectedProjectId || projectId || undefined,
            reportPolicy,
          }),
        });
        if (res.ok) {
          const task = await res.json();
          onCreated(task);
        }
      }
    } catch (err) {
      console.error(`Failed to ${isEditing ? 'update' : 'create'} task:`, err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-surface-900 border border-surface-700 rounded-t-xl sm:rounded-xl w-full max-w-md p-5 shadow-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-gray-200 mb-4">{isEditing ? t('editTask') : t('newTask')}</h3>

        <div className="space-y-3">
          <div>
            <label htmlFor="task-title" className="text-sm text-gray-400 mb-1 block">{t('title')}</label>
            <input
              id="task-title"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('titlePlaceholder')}
              className="w-full px-3 py-2 text-base bg-surface-800 border border-surface-700 rounded-lg text-gray-200 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSubmit()}
            />
          </div>

          <div>
            <label htmlFor="task-description" className="text-sm text-gray-400 mb-1 block">{t('description')}</label>
            <textarea
              id="task-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('descriptionPlaceholder')}
              rows={4}
              className="w-full px-3 py-2 text-base bg-surface-800 border border-surface-700 rounded-lg text-gray-200 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
            />
          </div>

          {/* File Attachments */}
          <div>
            <label className="text-sm text-gray-400 mb-1 block">{t('attachments')}</label>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => e.target.files && handleFileUpload(e.target.files)}
            />
            <div className="flex flex-wrap gap-1.5 items-center">
              {attachedFiles.map((f, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 px-2 py-1 text-sm bg-surface-750 border border-surface-600 rounded text-gray-300"
                >
                  <svg className="w-3 h-3 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                  </svg>
                  <span className="max-w-[120px] truncate">{f.name}</span>
                  <button
                    type="button"
                    onClick={() => setAttachedFiles((prev) => prev.filter((_, j) => j !== i))}
                    className="text-gray-500 hover:text-red-400 ml-0.5"
                  >
                    &times;
                  </button>
                </span>
              ))}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="inline-flex items-center gap-1 px-2 py-1 text-sm text-gray-400 hover:text-gray-200 border border-dashed border-surface-600 hover:border-surface-500 rounded transition-colors"
              >
                {uploading ? (
                  <span className="animate-spin w-3 h-3 border border-gray-400 border-t-transparent rounded-full" />
                ) : (
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                )}
                {uploading ? `${t('common:loading')}` : t('addFile')}
              </button>
            </div>
          </div>

          {/* Project Selection */}
          <div>
            <label className="text-sm text-gray-400 mb-1 block">{t('project')}</label>
            <select
              value={selectedProjectId}
              onChange={(e) => setSelectedProjectId(e.target.value)}
              className="w-full px-3 py-2 text-base bg-surface-800 border border-surface-700 rounded-lg text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer"
            >
              <option value="">{t('selectProject')}</option>
              {activeProjects.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          {/* Warning: creating in different project than filter */}
          {isDifferentFromFilter && (
            <div className="tone-card tone-warning flex items-center gap-2 px-3 py-2 rounded-lg text-sm">
              <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
              <span>
                {t('boardFilterWarning', { currentProject: allProjects.find(p => p.id === filterProjectId)?.name, targetProject: allProjects.find(p => p.id === selectedProjectId)?.name })}
                {' '}{t('wontAppearInView')}
              </span>
            </div>
          )}

          {/* Working Directory (auto-filled from project, editable) */}
          <div>
            <label htmlFor="task-cwd" className="text-sm text-gray-400 mb-1 flex items-center gap-1">
              {t('workingDirectory')}
              {selectedProjectId && (
                <span className="text-gray-600">{t('fromProject')}</span>
              )}
            </label>
            <input
              id="task-cwd"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder={effectiveCwd || '/home/user/project'}
              className="w-full px-3 py-2 text-base bg-surface-800 border border-surface-700 rounded-lg text-gray-200 font-mono placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label htmlFor="task-engine" className="text-sm text-gray-400 mb-1 block">Engine</label>
              <Dropdown
                value={engine}
                onChange={(next) => {
                  setEngine(next);
                  // Reset to the new engine's default model so we don't leave
                  // a Claude model id selected after switching to Pi (or vice
                  // versa). User can change it back in the model dropdown.
                  setModel(defaultModelByEngine[next] || '');
                }}
                options={ENGINE_OPTIONS}
              />
            </div>
            <div className="flex-1">
              <label htmlFor="task-model" className="text-sm text-gray-400 mb-1 block">{t('model')}</label>
              <Dropdown
                value={model}
                onChange={setModel}
                options={modelsByEngine[engine] || modelsByEngine.claude}
              />
            </div>
          </div>

          <div>
            <label htmlFor="task-workflow" className="text-sm text-gray-400 mb-1 block">{t('workflow')}</label>
            <Dropdown
              value={workflow}
              onChange={setWorkflow}
              options={WORKFLOW_OPTIONS}
            />
          </div>

          {/* Report policy — how completion gets reported. */}
          <div>
            <label htmlFor="task-report-policy" className="text-sm text-gray-400 mb-1 block">리포팅</label>
            <Dropdown
              value={reportPolicy}
              onChange={setReportPolicy}
              options={REPORT_POLICY_OPTIONS}
            />
            <p className="text-[13px] text-gray-500 mt-1">
              {reportPolicy === 'silent' && '완료되면 태스크 보드에만 표시됩니다.'}
              {reportPolicy === 'notification' && '완료 또는 실패 결과를 알림 센터에 남깁니다.'}
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={onClose}
            className="px-4 py-2 text-base text-gray-400 hover:text-gray-200 transition-colors"
          >
            {t('common:cancel')}
          </button>
          <button
            onClick={handleSubmit}
            disabled={!title.trim() || !effectiveCwd || submitting}
            className="px-4 py-2 text-base bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
          >
            {submitting ? (isEditing ? t('common:saving') : t('common:creating')) : (isEditing ? t('saveChanges') : t('createTask'))}
          </button>
        </div>
      </div>
    </div>
  );
}
