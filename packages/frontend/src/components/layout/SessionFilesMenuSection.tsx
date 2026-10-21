import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectRecentFile, TouchedFile } from '@tower/shared';

const MAX_VISIBLE_FILES = 20;

function fileName(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

type SessionMenuFile =
  | (TouchedFile & { isFallback?: false })
  | (ProjectRecentFile & { isFallback: true });

interface SessionFilesMenuSectionProps {
  activeSessionId: string | null;
  onFileClick: (path: string) => void;
  isMobile?: boolean;
  placement?: 'menu' | 'sidebar' | 'inline';
  onInlineBack?: () => void;
}

/** Shows a compact session-file entry and a scrollable second-level file panel. */
export function SessionFilesMenuSection({ activeSessionId, onFileClick, isMobile = false, placement = 'menu', onInlineBack }: SessionFilesMenuSectionProps) {
  const { t } = useTranslation('layout');
  const [files, setFiles] = React.useState<SessionMenuFile[]>([]);
  const [projectMissing, setProjectMissing] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [panelOpen, setPanelOpen] = React.useState(false);
  const [panelStyle, setPanelStyle] = React.useState<React.CSSProperties>({});
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!activeSessionId) {
      setFiles([]);
      setProjectMissing(false);
      setPanelOpen(false);
      return;
    }

    // Do not retain another session's or a previous authority snapshot's paths.
    setFiles([]);
    setProjectMissing(false);
    let cancelled = false;
    const fetchFiles = async () => {
      setLoading(true);
      try {
        const token = localStorage.getItem('token');
        const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
        const workingSetResponse = await fetch(
          `/api/sessions/${activeSessionId}/touched-files?limit=20`,
          { headers },
        );
        if (cancelled) return;
        if (workingSetResponse.ok) {
          const data = await workingSetResponse.json();
          if (cancelled) return;
          if (Array.isArray(data.files) && data.files.length > 0) {
            setFiles((data.files as TouchedFile[]).map((file) => ({ ...file, isFallback: false as const })));
            setProjectMissing(false);
            return;
          }
        }

        const fallbackResponse = await fetch(
          `/api/sessions/${activeSessionId}/project-recent-files?limit=20`,
          { headers },
        );
        if (cancelled) return;
        if (!fallbackResponse.ok) {
          setFiles([]);
          setProjectMissing(false);
          return;
        }
        if (fallbackResponse.ok) {
          const data = await fallbackResponse.json();
          if (cancelled) return;
          setProjectMissing(Boolean(data.projectMissing));
          setFiles(
            !data.projectMissing && Array.isArray(data.files)
              ? (data.files as ProjectRecentFile[]).map((file) => ({ ...file, isFallback: true as const }))
              : [],
          );
        }
      } catch {
        // Failed refresh must not keep stale file paths after authority changes.
        if (!cancelled) {
          setFiles([]);
          setProjectMissing(false);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void fetchFiles();
    const pollIfVisible = () => {
      if (document.visibilityState === 'visible') void fetchFiles();
    };
    const interval = window.setInterval(pollIfVisible, 30_000);
    document.addEventListener('visibilitychange', pollIfVisible);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', pollIfVisible);
    };
  }, [activeSessionId, panelOpen]);

  const positionPanel = React.useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = 288;
    const viewportPadding = 8;
    const menuTop = 56;
    const desktopLeft = rect.right + 8;
    const fitsRight = desktopLeft + width <= window.innerWidth - viewportPadding;
    const left = isMobile
      ? Math.max(viewportPadding, Math.min(rect.left, window.innerWidth - width - viewportPadding))
      : fitsRight
        ? desktopLeft
        : Math.max(viewportPadding, rect.left - width - 8);
    // The app menu opens from the header, while the folder sidebar trigger should
    // grow directly to its right from the top of the file-tree pane.
    const preferredTop = placement === 'sidebar' ? rect.top : menuTop;
    const top = Math.min(Math.max(viewportPadding, preferredTop), Math.max(viewportPadding, window.innerHeight - 240));
    const availableHeight = Math.max(232, window.innerHeight - top - viewportPadding);
    setPanelStyle({ left, top, width: Math.min(width, window.innerWidth - viewportPadding * 2), maxHeight: availableHeight });
  }, [isMobile, placement]);

  React.useEffect(() => {
    if (!panelOpen) return;
    positionPanel();
    window.addEventListener('resize', positionPanel);
    window.addEventListener('scroll', positionPanel, true);
    return () => {
      window.removeEventListener('resize', positionPanel);
      window.removeEventListener('scroll', positionPanel, true);
    };
  }, [panelOpen, positionPanel]);

  React.useEffect(() => {
    if (!panelOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) setPanelOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, [panelOpen]);

  const isFallback = files[0]?.isFallback === true;
  const visibleFiles = files.slice(0, MAX_VISIBLE_FILES);

  if (placement === 'inline') {
    return (
      <section className="min-h-full px-3 py-3">
        <button type="button" onClick={onInlineBack} className="mb-2 flex min-h-9 items-center gap-1 rounded-lg px-1 text-sm font-semibold text-surface-300 active:bg-surface-800"><span aria-hidden="true">‹</span><span>{t('files')}</span></button>
        <h2 className="px-1 text-base font-bold text-surface-100">{isFallback ? t('recentProjectFiles') : t('thisSessionFiles')}</h2>
        <p className="px-1 pt-1 text-[11px] leading-4 text-surface-600">{isFallback ? t('recentProjectFilesDescription') : t('sessionFilesDescription')}</p>
        <div className="mt-2 divide-y divide-surface-800/80">
          {!activeSessionId && <p className="px-1 py-4 text-sm text-surface-600">{t('selectSessionForFiles')}</p>}
          {activeSessionId && projectMissing && <p className="px-1 py-4 text-sm text-surface-600">{t('setWorkspaceForFiles')}</p>}
          {activeSessionId && !projectMissing && files.length === 0 && !loading && <p className="px-1 py-4 text-sm text-surface-600">{t('noEditedFilesYet')}</p>}
          {loading && files.length === 0 && <p className="px-1 py-4 text-sm text-surface-600">{t('loadingFiles')}</p>}
          {visibleFiles.map((file) => (
            <button key={file.path} type="button" onClick={() => onFileClick(file.path)} title={file.path} className="flex w-full items-center gap-2 px-1 py-3 text-left active:bg-surface-800">
              <svg className="h-4 w-4 shrink-0 text-surface-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 3h9l3 3v15H6zM14 3v4h4" /></svg>
              <span className="min-w-0 flex-1 truncate font-mono text-sm text-surface-200">{fileName(file.path)}</span>
              {file.isFallback === true && <span className="text-[10px] text-surface-600">{t('recent')}</span>}
            </button>
          ))}
        </div>
      </section>
    );
  }

  return (
    <div className={placement === 'sidebar' ? 'px-2 pb-2 pt-2' : 'px-2 pb-1'}>
      <button
        ref={triggerRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setPanelOpen((current) => !current);
        }}
        aria-expanded={panelOpen}
        aria-haspopup="dialog"
        className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[13px] text-gray-400 transition-colors hover:bg-surface-800 hover:text-gray-200"
      >
        <svg className="h-4 w-4 shrink-0 text-surface-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 3h9l3 3v15H6zM14 3v4h4" />
        </svg>
        <span className="min-w-0 flex-1 truncate">{t('thisSessionFiles')}</span>
        <span className="min-w-5 text-right text-[12px] tabular-nums text-surface-500">{loading ? '…' : files.length}</span>
        <svg className="h-4 w-4 shrink-0 text-surface-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="m9 5 7 7-7 7" />
        </svg>
      </button>

      {panelOpen && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label={isFallback ? t('recentProjectFiles') : t('thisSessionFiles')}
          style={panelStyle}
          onMouseDown={(event) => event.stopPropagation()}
          className="fixed z-[110] flex overflow-hidden rounded-xl border border-surface-700 bg-surface-900 shadow-2xl shadow-black/50"
        >
          <div className="flex min-h-0 w-full flex-col">
            <div className="shrink-0 border-b border-surface-800 px-3 py-3">
              <button
                type="button"
                onClick={() => setPanelOpen(false)}
                className="mb-2 flex items-center gap-1 rounded-md text-[13px] text-surface-400 hover:text-gray-200"
              >
                <span aria-hidden="true">‹</span>
                <span>{isFallback ? t('recentProjectFiles') : t('thisSessionFiles')}</span>
              </button>
              <p className="text-[12px] leading-5 text-surface-500">
                {isFallback ? t('recentProjectFilesDescription') : t('sessionFilesDescription')}
              </p>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2 [scrollbar-width:thin]">
              {!activeSessionId && (
                <p className="px-2 py-4 text-[12px] italic text-surface-600">{t('selectSessionForFiles')}</p>
              )}
              {activeSessionId && projectMissing && (
                <p className="px-2 py-4 text-[12px] italic text-surface-600">{t('setWorkspaceForFiles')}</p>
              )}
              {activeSessionId && !projectMissing && files.length === 0 && !loading && (
                <p className="px-2 py-4 text-[12px] italic text-surface-600">{t('noEditedFilesYet')}</p>
              )}
              {loading && files.length === 0 && (
                <p className="px-2 py-4 text-[12px] text-surface-600">{t('loadingFiles')}</p>
              )}
              {visibleFiles.map((file) => {
                const fallbackFile = file.isFallback === true;
                const sessionName = fallbackFile ? file.sessionName : undefined;
                return (
                  <button
                    key={file.path}
                    type="button"
                    onClick={() => onFileClick(file.path)}
                    title={fallbackFile && sessionName ? t('fileSourceTooltip', { path: file.path, session: sessionName }) : file.path}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-800"
                  >
                    <svg className="h-3.5 w-3.5 shrink-0 text-surface-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 3h9l3 3v15H6zM14 3v4h4" />
                    </svg>
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px] leading-4 text-gray-300">{fileName(file.path)}</span>
                    {fallbackFile && <span className="shrink-0 text-[10px] text-surface-600">{t('recent')}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
