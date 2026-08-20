// Owns: full-screen Finder-like file browser for the Files nav view.
// Public API: <FilesWorkspace onFileClick onRequestFileTree />.
// See also: Sidebar's compact FileTree for quick navigation.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FileEntry } from "../../stores/file-store";
import { useFileStore, type FileEntrySortMode } from "../../stores/file-store";
import { useProjectStore, type Project } from "../../stores/project-store";
import { useSessionStore } from "../../stores/session-store";
import { isOperatorOrAdmin } from "../../utils/auth";
import { toastError, toastSuccess } from "../../utils/toast";
import { notifyUploadResult } from "../../utils/upload-notice";
import { MarkdownReadSurface } from "./MarkdownReadSurface";
import {
  uploadDroppedFiles,
  readDroppedItems,
  type DroppedFile,
} from "../../utils/folder-drop";
import { fileServeUrl } from "../../utils/file-path-links";
import { useConfirm, usePrompt } from "../../hooks/useDialog";
import { transferFile } from "../../features/file-exchange/fileExchange";
import { ViewportContextMenu } from "../common/ViewportContextMenu";
import { UploadProgressChip } from "../common/UploadProgressChip";
import { AgentIdentityAvatar } from "../../features/agent-profile/AgentIdentityAvatar";
import { useSettingsStore } from "../../stores/settings-store";
import type { UploadProgressSnapshot } from "../../utils/upload-with-progress";

interface PublishedSite {
  name: string;
  slug?: string;
  description?: string;
  access?: string;
  created_at?: string;
  last_deployed_at?: string;
  external_url?: string;
  project?: string;
  status?: string;
}
interface SharedFile {
  id: string;
  file_path: string;
  fileName?: string;
  name?: string;
  ext?: string;
  project?: string;
  url?: string | null;
  expires_at?: string | null;
  created_at?: string;
  expired?: boolean;
  revoked?: boolean;
}

interface FilesWorkspaceProps {
  onFileClick: (path: string) => void;
  onRequestFileTree?: (path?: string) => void;
  initialProjectId?: string | null;
  embedded?: boolean;
  revealPath?: string | null;
  onRevealComplete?: () => void;
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function formatBytes(bytes?: number): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i++) {
    value /= 1024;
    unit = units[i];
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

function formatModified(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function FileGlyph({ entry }: { entry: FileEntry }) {
  const ext = (
    entry.extension ||
    entry.name.split(".").pop() ||
    ""
  ).toLowerCase();
  if (entry.isDirectory)
    return (
      <svg
        className="h-3.5 w-3.5"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path d="M2.75 5.75h5l1.5 1.75h8v7.75h-14.5z" strokeLinejoin="round" />
      </svg>
    );
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext))
    return (
      <svg
        className="h-3.5 w-3.5"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <rect x="3" y="3" width="14" height="14" rx="1.5" />
        <path d="m5.5 14 3.25-3.5 2.25 2 2-2.25L16 14" />
        <circle cx="7" cy="7" r="1" />
      </svg>
    );
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M5 2.75h6l4 4v10.5H5z" strokeLinejoin="round" />
      <path d="M11 2.75v4h4" />
    </svg>
  );
}

function relativePath(path: string, rootPath?: string | null): string {
  if (!rootPath) return path;
  const rel = path === rootPath ? "" : path.replace(`${rootPath}/`, "");
  return rel || "/";
}

function entrySizeLabel(entry: FileEntry): string {
  return entry.isDirectory ? "Folder" : formatBytes(entry.size);
}

function flattenEntries(entries: FileEntry[]): FileEntry[] {
  const result: FileEntry[] = [];
  const walk = (items: FileEntry[]) => {
    for (const item of items) {
      result.push(item);
      if (item.children) walk(item.children);
    }
  };
  walk(entries);
  return result;
}

function sortEntries(
  entries: FileEntry[],
  mode: FileEntrySortMode,
): FileEntry[] {
  const list = [...entries];
  const byName = (a: FileEntry, b: FileEntry) =>
    a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  return list.sort((a, b) => {
    if (mode === "folders-name") {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return byName(a, b);
    }
    if (mode === "modified") {
      const at = a.modified ? new Date(a.modified).getTime() : 0;
      const bt = b.modified ? new Date(b.modified).getTime() : 0;
      return bt - at || byName(a, b);
    }
    if (mode === "type") {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      const ae = a.isDirectory
        ? ""
        : a.extension || a.name.split(".").pop() || "";
      const be = b.isDirectory
        ? ""
        : b.extension || b.name.split(".").pop() || "";
      return ae.localeCompare(be) || byName(a, b);
    }
    return byName(a, b);
  });
}

function sortProjects(projects: Project[]): Project[] {
  return [...projects]
    .filter((p) => !!p.rootPath && !p.archived)
    .sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return (
        (a.pinOrder ?? 9999) - (b.pinOrder ?? 9999) ||
        a.name.localeCompare(b.name, undefined, {
          numeric: true,
          sensitivity: "base",
        })
      );
    });
}

export function FilesWorkspace({
  onFileClick,
  onRequestFileTree,
  initialProjectId,
  embedded = false,
  revealPath,
  onRevealComplete,
}: FilesWorkspaceProps) {
  const { t, i18n } = useTranslation("files");
  const confirm = useConfirm();
  const prompt = usePrompt();
  const projects = useProjectStore((s) => s.projects);
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const isMobile = useSessionStore((s) => s.isMobile);
  const setCapabilityProjectId = useSettingsStore((s) => s.setCapabilityProjectId);
  const showHidden = useFileStore((s) => s.showHidden);
  const toggleShowHidden = useFileStore((s) => s.toggleShowHidden);
  const fileSortMode = useFileStore((s) => s.fileSortMode);
  const setFileSortMode = useFileStore((s) => s.setFileSortMode);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [currentPath, setCurrentPath] = useState<string>("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [columnEntries, setColumnEntries] = useState<
    Record<string, FileEntry[]>
  >({});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(),
  );
  const [kindFilter, setKindFilter] = useState<"all" | "folders" | "files">(
    "all",
  );
  const [libraryView, setLibraryView] = useState<
    "all" | "published" | "sharedFiles" | "projectSkills" | "sharedSkills"
  >("all");
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const [publishedSites, setPublishedSites] = useState<PublishedSite[]>([]);
  const [publishLoading, setPublishLoading] = useState(false);
  const [sharedFiles, setSharedFiles] = useState<SharedFile[]>([]);
  const [sharesLoading, setSharesLoading] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectionMode, setSelectionMode] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [transferProjectId, setTransferProjectId] = useState("");
  const [transferDirectory, setTransferDirectory] = useState("");
  const [transferDirectories, setTransferDirectories] = useState<FileEntry[]>([]);
  const [transferDirectoriesLoading, setTransferDirectoriesLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<UploadProgressSnapshot | null>(null);
  const fileUploadRef = React.useRef<HTMLInputElement>(null);
  const folderUploadRef = React.useRef<HTMLInputElement>(null);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const loadedProjectIdRef = React.useRef<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<FileEntry[] | null>(null);
  const [fileHistory, setFileHistory] = useState<
    Array<{ label: string; undo?: () => Promise<void> }>
  >([]);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [inlineCreate, setInlineCreate] = useState<"file" | "folder" | null>(
    null,
  );
  const [inlineCreateName, setInlineCreateName] = useState("");
  const [inlineCreateTargetPath, setInlineCreateTargetPath] = useState<
    string | null
  >(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    entry: FileEntry;
  } | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [instructionsLoading, setInstructionsLoading] = useState(false);
  const [instructionsContent, setInstructionsContent] = useState("");
  const [instructionsError, setInstructionsError] = useState("");

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const closeSearch = () => {
    setQuery("");
    setSearchOpen(false);
  };

  const sortedProjects = useMemo(() => sortProjects(projects), [projects]);
  const activeSessionProjectId =
    sessions.find((s) => s.id === activeSessionId)?.projectId || "";
  const selectedProject =
    sortedProjects.find((p) => p.id === selectedProjectId) || sortedProjects[0];
  const rootPath = selectedProject?.rootPath || "";

  useEffect(() => {
    if (
      selectedProjectId &&
      sortedProjects.some((p) => p.id === selectedProjectId)
    )
      return;
    const preferred =
      sortedProjects.find((p) => p.id === initialProjectId) ||
      sortedProjects.find((p) => p.id === activeSessionProjectId) ||
      sortedProjects[0];
    if (preferred) {
      setSelectedProjectId(preferred.id);
      setCurrentPath(preferred.rootPath || "");
    }
  }, [
    activeSessionProjectId,
    initialProjectId,
    selectedProjectId,
    sortedProjects,
  ]);

  useEffect(() => {
    const project = sortedProjects.find((p) => p.id === selectedProjectId);
    if (
      project?.rootPath &&
      (!currentPath || !currentPath.startsWith(project.rootPath))
    ) {
      setCurrentPath(project.rootPath);
    }
  }, [currentPath, selectedProjectId, sortedProjects]);

  const loadDirectory = useCallback(
    async (path: string, replaceRootEntries = true) => {
      if (!path) return;
      const showBlockingLoader =
        replaceRootEntries && loadedProjectIdRef.current !== selectedProjectId;
      if (showBlockingLoader) setLoading(true);
      try {
        const includeHidden = showHidden || path.includes("/.tower/");
        const url = `/api/files/tree?path=${encodeURIComponent(path)}${includeHidden ? "&showHidden=true" : ""}`;
        const res = await fetch(url, { headers: authHeaders() });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const missingOptionalLibrary =
            res.status === 404 ||
            /ENOENT|no such file|Cannot read directory/i.test(
              String(data.error || ""),
            );
          if (missingOptionalLibrary && libraryView !== "all") {
            if (replaceRootEntries) setEntries([]);
            setColumnEntries((current) => ({ ...current, [path]: [] }));
            return;
          }
          throw new Error(
            data.error || t('workspace.loadListFailed') + ` (${res.status})`,
          );
        }
        const nextEntries = Array.isArray(data.entries) ? data.entries : [];
        if (replaceRootEntries) setEntries(nextEntries);
        setColumnEntries((current) => ({ ...current, [path]: nextEntries }));
      } catch (err) {
        console.error("[FilesWorkspace] loadDirectory failed", err);
        toastError(
          err instanceof Error
            ? err.message
            : t('workspace.loadListFailed'),
        );
        if (replaceRootEntries) setEntries([]);
      } finally {
        if (replaceRootEntries) loadedProjectIdRef.current = selectedProjectId;
        if (showBlockingLoader) setLoading(false);
      }
    },
    [libraryView, selectedProjectId, showHidden],
  );

  useEffect(() => {
    if (currentPath) void loadDirectory(currentPath, true);
  }, [currentPath, loadDirectory]);

  useEffect(() => {
    if (!revealPath || !rootPath || (revealPath !== rootPath && !revealPath.startsWith(`${rootPath}/`))) return;
    let cancelled = false;
    const reveal = async () => {
      try {
        const params = new URLSearchParams({ path: revealPath, rootPath });
        if (showHidden) params.set('showHidden', 'true');
        const res = await fetch(`/api/files/reveal?${params.toString()}`, { headers: authHeaders() });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || t('workspace.loadLocationFailed'));
        const ancestors = Array.isArray(data.ancestors) ? data.ancestors as string[] : [];
        const entriesByPath = data.entriesByPath && typeof data.entriesByPath === 'object' ? data.entriesByPath as Record<string, FileEntry[]> : {};
        if (cancelled) return;
        setCurrentPath(rootPath);
        setQuery('');
        setLibraryView('all');
        setExpandedPaths(new Set(ancestors));
        setEntries(Array.isArray(entriesByPath[rootPath]) ? entriesByPath[rootPath] : []);
        setColumnEntries(entriesByPath);
        window.setTimeout(() => {
          const escaped = window.CSS?.escape ? window.CSS.escape(revealPath) : revealPath.replace(/(["'\\\]\[])/g, '\\$1');
          const element = document.querySelector<HTMLElement>(`[data-files-workspace-path="${escaped}"]`);
          if (!element) return;
          element.scrollIntoView({ block: 'center', behavior: 'smooth' });
          element.classList.add('tower-sidebar-reveal-highlight-file');
          window.setTimeout(() => element.classList.remove('tower-sidebar-reveal-highlight-file'), 2200);
        }, 80);
      } catch (error) {
        toastError(error instanceof Error ? error.message : t('workspace.loadLocationFailed'));
      } finally {
        if (!cancelled) onRevealComplete?.();
      }
    };
    void reveal();
    return () => { cancelled = true; };
  }, [onRevealComplete, revealPath, rootPath, showHidden]);

  useEffect(() => {
    const needle = query.trim();
    if (needle.length < 2) {
      setSearchResults(null);
      return;
    }
    const timer = setTimeout(() => {
      fetch(
        `/api/files/search?root=${encodeURIComponent(rootPath)}&q=${encodeURIComponent(needle)}${showHidden ? "&showHidden=true" : ""}`,
        { headers: authHeaders() },
      )
        .then(async (res) => {
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || t('workspace.searchFailed'));
          setSearchResults(Array.isArray(data.results) ? data.results : []);
        })
        .catch((error) => toastError(error.message || t('workspace.searchFailed')));
    }, 250);
    return () => clearTimeout(timer);
  }, [query, rootPath, showHidden]);

  const displayedEntries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const source =
      searchResults ??
      (needle
        ? flattenEntries(entries).filter((entry) =>
            `${entry.name} ${entry.path}`.toLowerCase().includes(needle),
          )
        : entries);
    return sortEntries(
      source.filter(
        (entry) =>
          kindFilter === "all" ||
          (kindFilter === "folders" ? entry.isDirectory : !entry.isDirectory),
      ),
      fileSortMode,
    );
  }, [entries, fileSortMode, kindFilter, query, searchResults]);

  const breadcrumbs = useMemo(() => {
    if (!rootPath || !currentPath.startsWith(rootPath)) return [];
    const rel = currentPath.slice(rootPath.length).replace(/^\/+/, "");
    const parts = rel ? rel.split("/").filter(Boolean) : [];
    const crumbs = [
      { label: selectedProject?.name || "Project", path: rootPath },
    ];
    let cursor = rootPath;
    for (const part of parts) {
      cursor = `${cursor}/${part}`;
      crumbs.push({ label: part, path: cursor });
    }
    return crumbs;
  }, [currentPath, rootPath, selectedProject?.name]);

  const parentDirectory = useCallback(
    (path: string) => path.split("/").slice(0, -1).join("/"),
    [],
  );
  const refreshDirectories = useCallback(async (changedDirectories: Iterable<string>) => {
    // One refresh contract for every file mutation: keep existing outline
    // branches, normalize duplicate paths, then reload only affected folders.
    const directories = [...new Set([currentPath, ...changedDirectories].filter(Boolean))];
    await Promise.all(
      directories.map((directory) => loadDirectory(directory, directory === currentPath)),
    );
    onRequestFileTree?.(directories.find((directory) => directory !== currentPath) || currentPath);
  }, [currentPath, loadDirectory, onRequestFileTree]);
  const runFileMutation = useCallback(async <T,>({
    action,
    affectedDirectories,
    removedPaths = [],
    pathReplacements = [],
  }: {
    action: () => Promise<T>;
    affectedDirectories: Iterable<string>;
    removedPaths?: Iterable<string>;
    pathReplacements?: Iterable<{ from: string; to: string }>;
  }): Promise<T> => {
    const result = await action();
    const removed = [...removedPaths];
    const replacements = [...pathReplacements];
    const reconcilePaths = (current: Set<string>) => new Set(
      [...current].flatMap((path) => {
        const replacement = replacements.find(
          ({ from }) => path === from || path.startsWith(`${from}/`),
        );
        if (replacement) return [`${replacement.to}${path.slice(replacement.from.length)}`];
        if (removed.some(
          (removedPath) => path === removedPath || path.startsWith(`${removedPath}/`),
        )) return [];
        return [path];
      }),
    );
    if (removed.length > 0 || replacements.length > 0) {
      setExpandedPaths(reconcilePaths);
      setSelectedPaths(reconcilePaths);
    }
    await refreshDirectories(affectedDirectories);
    return result;
  }, [refreshDirectories]);
  const uploadItems = async (
    items: DroppedFile[],
    targetPath = currentPath,
  ) => {
    if (!items.length) return;
    setBusyAction("upload");
    const totalBytes = items.reduce((sum, item) => sum + item.file.size, 0);
    setUploadProgress({ phase: 'uploading', loadedBytes: 0, totalBytes, percent: 0, completedFiles: 0, totalFiles: items.length, currentFileName: items[0]?.relativePath || t('workspace.fileFallback') });
    try {
      const result = await runFileMutation({
        action: () => uploadDroppedFiles(targetPath, items, setUploadProgress),
        affectedDirectories: [targetPath],
      });
      const targetName = targetPath.split("/").filter(Boolean).pop();
      notifyUploadResult(
        { ok: result.ok, fail: result.fail },
        targetPath === currentPath ? undefined : (targetName || t('workspace.selectedFolder')),
      );
    } finally {
      setBusyAction(null);
      setUploadProgress(null);
    }
  };
  const handleFileInput = (files: FileList | null) =>
    void uploadItems(
      Array.from(files || []).map((file) => ({
        file,
        relativePath: (file as any).webkitRelativePath || file.name,
      })),
    );
  const beginCreate = (kind: "file" | "folder", targetPath = currentPath) => {
    setCreateMenuOpen(false);
    setInlineCreate(kind);
    setInlineCreateName("");
    setInlineCreateTargetPath(targetPath);
  };
  const cancelCreate = () => {
    setInlineCreate(null);
    setInlineCreateName("");
    setInlineCreateTargetPath(null);
  };
  const submitCreate = async () => {
    const name = inlineCreateName.trim();
    if (!inlineCreate || !name) return;
    const targetDir = inlineCreateTargetPath || currentPath;
    setBusyAction("create");
    try {
      const target = `${targetDir}/${name}`;
      await runFileMutation({
        action: () => postJson(
          inlineCreate === "file" ? "/api/files/create" : "/api/files/mkdir",
          inlineCreate === "file"
            ? { path: target, content: "" }
            : { path: target },
        ),
        affectedDirectories: [targetDir],
      });
      cancelCreate();
      if (targetDir !== currentPath) {
        setExpandedPaths((current) => new Set(current).add(targetDir));
      }
    } catch (error) {
      toastError(error instanceof Error ? error.message : t('workspace.createFailed'));
    } finally {
      setBusyAction(null);
    }
  };
  const postJson = async (url: string, body: any) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t('workspace.operationFailed'));
    return data;
  };
  const renameSelected = async () => {
    if (selectedPaths.size !== 1) return;
    const oldPath = [...selectedPaths][0];
    const oldName = oldPath.split("/").pop() || "";
    const name = await prompt({ title: t('workspace.renameTitle'), message: t('workspace.renameMessage'), initialValue: oldName, confirmLabel: t('workspace.renameConfirm') });
    if (!name?.trim() || name === oldName) return;
    const newPath = `${oldPath.split("/").slice(0, -1).join("/")}/${name.trim()}`;
    try {
      await runFileMutation({
        action: () => postJson("/api/files/rename", { oldPath, newPath }),
        affectedDirectories: [parentDirectory(oldPath)],
        pathReplacements: [{ from: oldPath, to: newPath }],
      });
      setFileHistory((items) =>
        [
          {
            label: t('workspace.renameHistory', { name: oldName }),
            undo: async () => {
              await runFileMutation({
                action: () => postJson("/api/files/rename", {
                  oldPath: newPath,
                  newPath: oldPath,
                }),
                affectedDirectories: [parentDirectory(oldPath)],
                pathReplacements: [{ from: newPath, to: oldPath }],
              });
            },
          },
          ...items,
        ].slice(0, 8),
      );
      setSelectedPaths(new Set());
    } catch (e) {
      toastError(e instanceof Error ? e.message : t('workspace.renameFailed'));
    }
  };
  const deleteSelected = async () => {
    const paths = [...selectedPaths];
    if (!paths.length) return;
    const approved = await confirm({
      title: t('workspace.deleteTitle'),
      message: t('workspace.deleteMessage', { count: paths.length }),
      confirmLabel: t('workspace.delete'),
      danger: true,
    });
    if (!approved) return;
    let ok = 0;
    const deletedPaths: string[] = [];
    await runFileMutation({
      action: async () => {
        for (const path of paths)
          try {
            await postJson("/api/files/delete", { path });
            deletedPaths.push(path);
            ok++;
          } catch {}
      },
      affectedDirectories: paths.map(parentDirectory),
      removedPaths: deletedPaths,
    });
    toastSuccess(t('workspace.deletedHistory', { count: ok }));
    setFileHistory((items) =>
      [{ label: t('workspace.deletedHistory', { count: ok }) }, ...items].slice(0, 8),
    );
    setSelectedPaths(new Set());
  };
  const moveSelected = async () => {
    const targetDir = await prompt({ title: t('workspace.moveTitle'), message: t('workspace.moveMessage'), initialValue: rootPath, confirmLabel: t('workspace.move') });
    if (!targetDir?.startsWith(rootPath))
      return toastError(t('workspace.invalidProjectPath'));
    const moves = [...selectedPaths].map((oldPath) => ({
      oldPath,
      newPath: `${targetDir}/${oldPath.split("/").pop()}`,
    }));
    await runFileMutation({
      action: async () => {
        for (const move of moves) {
          await postJson("/api/files/rename", move);
        }
      },
      affectedDirectories: [targetDir, ...moves.map((move) => parentDirectory(move.oldPath))],
      pathReplacements: moves.map((move) => ({ from: move.oldPath, to: move.newPath })),
    });
    setFileHistory((items) =>
      [
        {
          label: t('workspace.movedHistory', { count: moves.length }),
          undo: async () => {
            await runFileMutation({
              action: async () => {
                for (const move of [...moves].reverse()) {
                  await postJson("/api/files/rename", {
                    oldPath: move.newPath,
                    newPath: move.oldPath,
                  });
                }
              },
              affectedDirectories: [targetDir, ...moves.map((move) => parentDirectory(move.oldPath))],
              pathReplacements: moves.map((move) => ({ from: move.newPath, to: move.oldPath })),
            });
          },
        },
        ...items,
      ].slice(0, 8),
    );
    setSelectedPaths(new Set());
  };
  const downloadSelected = () => {
    const paths = [...selectedPaths];
    const token = localStorage.getItem("token");
    if (paths.length === 1) {
      const entry = flattenEntries(entries).find(
        (item) => item.path === paths[0],
      );
      if (entry && !entry.isDirectory) {
        const baseUrl = fileServeUrl(paths[0]);
        const url = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}download=1`;
        const a = document.createElement("a");
        a.href = url;
        a.download = entry.name;
        a.click();
        return;
      }
    }
    const params = new URLSearchParams({ paths: JSON.stringify(paths) });
    if (token) params.set("token", token);
    window.open(`/api/files/download-zip-selected?${params}`, "_blank");
  };
  const copySelectedPaths = async () => {
    const paths = [...selectedPaths];
    if (!paths.length) return;
    try {
      await navigator.clipboard.writeText(paths.join("\n"));
      toastSuccess(t('workspace.pathsCopied', { count: paths.length }));
    } catch {
      toastError(t('workspace.copyPathsFailed'));
    }
  };
  const loadTransferDirectories = useCallback(async (directory: string) => {
    if (!directory) return;
    setTransferDirectoriesLoading(true);
    try {
      const response = await fetch(`/api/files/tree?path=${encodeURIComponent(directory)}`, { headers: authHeaders() });
      if (!response.ok) throw new Error(t('workspace.destinationLoadFailed'));
      const data = await response.json();
      setTransferDirectories((data.entries || []).filter((entry: FileEntry) => entry.isDirectory));
    } catch (error) {
      setTransferDirectories([]);
      toastError(error instanceof Error ? error.message : t('workspace.destinationLoadFailed'));
    } finally { setTransferDirectoriesLoading(false); }
  }, [t]);
  const selectTransferProject = (projectId: string) => {
    setTransferProjectId(projectId);
    const directory = sortedProjects.find((project) => project.id === projectId)?.rootPath || "";
    setTransferDirectory(directory);
    setTransferDirectories([]);
    if (directory) void loadTransferDirectories(directory);
  };
  const navigateTransferDirectory = (directory: string) => {
    setTransferDirectory(directory);
    void loadTransferDirectories(directory);
  };
  const transferProjectRoot = sortedProjects.find((project) => project.id === transferProjectId)?.rootPath || "";
  const transferParentDirectory = transferDirectory && transferDirectory !== transferProjectRoot ? transferDirectory.split("/").slice(0, -1).join("/") : "";
  const copySelectedToProject = async () => {
    const target = sortedProjects.find((project) => project.id === transferProjectId);
    if (!target?.rootPath || !selectedPaths.size || !selectedProject?.id) return;
    const selectedFiles = [...selectedPaths].filter((selectedPath) => {
      const entry = flattenEntries(entries).find((item) => item.path === selectedPath);
      return entry && !entry.isDirectory;
    });
    if (!selectedFiles.length) return toastError(t('workspace.filesOnlyTransfer'));
    const approved = await confirm({
      title: t('workspace.transferTitle'),
      message: t('workspace.transferMessageWithPath', { count: selectedFiles.length, name: target.agent?.displayName || target.name, path: transferDirectory.slice(target.rootPath.length).replace(/^\/+/, "") || t('workspace.workspaceRoot') }),
      confirmLabel: t('workspace.copyAndSend'),
    });
    if (!approved) return;
    setBusyAction("copy");
    try {
      let copied = 0;
      for (const selectedPath of selectedFiles) {
        const relativePath = selectedPath.slice(rootPath.length).replace(/^\/+/, "");
        const receipt = await transferFile(
          { scope: "project", projectId: selectedProject.id, relativePath },
          { scope: "project", projectId: target.id, relativeDirectory: transferDirectory.slice(target.rootPath.length).replace(/^\/+/, "") },
          async () => true,
        );
        if (receipt?.status === "completed") copied += 1;
        else throw new Error(receipt?.status === "stale" ? t('workspace.sourceChanged') : t('workspace.transferDenied'));
      }
      toastSuccess(t('workspace.transferSuccess', { count: copied, name: target.agent?.displayName || target.name }));
      setSelectedPaths(new Set());
    } catch (error) {
      toastError(error instanceof Error ? error.message : t('workspace.copyFailed'));
    } finally {
      setBusyAction(null);
    }
  };
  const moveEntry = useCallback(
    async (entry: FileEntry, targetDir: string) => {
      const newPath = `${targetDir}/${entry.name}`;
      if (entry.path === newPath || targetDir.startsWith(`${entry.path}/`))
        return;
      try {
        await runFileMutation({
          action: async () => {
            const res = await fetch("/api/files/rename", {
              method: "POST",
              headers: { ...authHeaders(), "Content-Type": "application/json" },
              body: JSON.stringify({ oldPath: entry.path, newPath }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok)
              throw new Error(data.error || t('workspace.moveFileFailed'));
          },
          affectedDirectories: [parentDirectory(entry.path), targetDir],
          pathReplacements: [{ from: entry.path, to: newPath }],
        });
      } catch (error) {
        toastError(
          error instanceof Error ? error.message : t('workspace.moveFileFailed'),
        );
      }
    },
    [parentDirectory, runFileMutation],
  );

  const dragProps = (entry: FileEntry) => ({
    draggable: true,
    onDragStart: (event: React.DragEvent) => {
      event.dataTransfer.setData(
        "application/x-filetree-move",
        JSON.stringify({
          type: entry.isDirectory ? "directory" : "file",
          path: entry.path,
          name: entry.name,
        }),
      );
      event.dataTransfer.effectAllowed = "move";
    },
  });
  const folderDropProps = (entry: FileEntry) =>
    entry.isDirectory
      ? {
          onDragEnter: (event: React.DragEvent) => {
            const isInternalMove = event.dataTransfer.types.includes(
              "application/x-filetree-move",
            );
            const hasExternalFiles = event.dataTransfer.types.includes("Files");
            if (!isInternalMove && !hasExternalFiles) return;
            event.preventDefault();
            event.stopPropagation();
            setDropActive(false);
            setDragOverPath(entry.path);
          },
          onDragOver: (event: React.DragEvent) => {
            const isInternalMove = event.dataTransfer.types.includes(
              "application/x-filetree-move",
            );
            const hasExternalFiles = event.dataTransfer.types.includes("Files");
            if (!isInternalMove && !hasExternalFiles) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = isInternalMove ? "move" : "copy";
            setDropActive(false);
            setDragOverPath(entry.path);
          },
          onDragLeave: (event: React.DragEvent) => {
            event.preventDefault();
            event.stopPropagation();
            if (!event.currentTarget.contains(event.relatedTarget as Node)) {
              setDragOverPath(null);
            }
          },
          onDrop: (event: React.DragEvent) => {
            event.preventDefault();
            event.stopPropagation();
            setDropActive(false);
            setDragOverPath(null);
            if (
              event.dataTransfer.types.includes("application/x-filetree-move")
            ) {
              try {
                const data = JSON.parse(
                  event.dataTransfer.getData("application/x-filetree-move"),
                );
                void moveEntry(data, entry.path);
              } catch {}
              return;
            }
            if (event.dataTransfer.types.includes("Files")) {
              void readDroppedItems(event.dataTransfer)
                .then((items) => uploadItems(items, entry.path))
                .catch((error) => {
                  console.error("[FilesWorkspace] folder drop failed", error);
                  toastError(t('workspace.readDropFailed'));
                });
            }
          },
        }
      : {};

  const toggleFolder = async (entry: FileEntry) => {
    if (!entry.isDirectory) return;
    const opening = !expandedPaths.has(entry.path);
    setExpandedPaths((current) => {
      const next = new Set(current);
      opening ? next.add(entry.path) : next.delete(entry.path);
      return next;
    });
    if (opening && !columnEntries[entry.path])
      await loadDirectory(entry.path, false);
  };

  const clearSelection = () => {
    setSelectedPaths(new Set());
    setSelectionMode(false);
  };
  const toggleSelection = (path: string) => {
    setSelectionMode(true);
    setSelectedPaths((current) => {
      const next = new Set(current);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  };
  const activateEntry = (entry: FileEntry, event?: React.MouseEvent) => {
    if (selectionMode || event?.metaKey || event?.ctrlKey) {
      toggleSelection(entry.path);
      return;
    }
    openEntry(entry);
  };
  const openEntry = (entry: FileEntry) => {
    if (entry.isDirectory) {
      void toggleFolder(entry);
      return;
    }
    onFileClick(entry.path);
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && selectionMode) clearSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectionMode]);

  const outlineRows = useMemo(() => {
    const rows: Array<{ entry: FileEntry; depth: number }> = [];
    const walk = (items: FileEntry[], depth: number) => {
      for (const entry of sortEntries(items, fileSortMode)) {
        if (
          kindFilter !== "all" &&
          (kindFilter === "folders" ? !entry.isDirectory : entry.isDirectory)
        )
          continue;
        const matches =
          !query.trim() ||
          `${entry.name} ${entry.path}`
            .toLowerCase()
            .includes(query.trim().toLowerCase());
        if (matches) rows.push({ entry, depth });
        if (entry.isDirectory && expandedPaths.has(entry.path))
          walk(columnEntries[entry.path] || [], depth + 1);
      }
    };
    walk(entries, 0);
    return rows;
  }, [columnEntries, entries, expandedPaths, fileSortMode, kindFilter, query]);

  useEffect(() => {
    if (libraryView !== "published") return;
    setPublishLoading(true);
    fetch("/api/publish/status", { headers: authHeaders() })
      .then((res) => res.json())
      .then((data) =>
        setPublishedSites(
          Array.isArray(data.sites)
            ? data.sites.filter(
                (site: PublishedSite) =>
                  site.project === selectedProject?.name ||
                  site.project === selectedProject?.rootPath?.split("/").pop(),
              )
            : [],
        ),
      )
      .catch(() => setPublishedSites([]))
      .finally(() => setPublishLoading(false));
  }, [libraryView, selectedProject?.name, selectedProject?.rootPath]);

  useEffect(() => {
    if (libraryView !== "sharedFiles") return;
    setSharesLoading(true);
    fetch("/api/shares/external", { headers: authHeaders() })
      .then((res) => res.json())
      .then((data) =>
        setSharedFiles(
          Array.isArray(data)
            ? data.filter(
                (share: SharedFile) =>
                  share.project === selectedProject?.rootPath?.split("/").pop(),
              )
            : [],
        ),
      )
      .catch(() => setSharedFiles([]))
      .finally(() => setSharesLoading(false));
  }, [libraryView, selectedProject?.rootPath]);

  const revokeSharedFile = async (share: SharedFile) => {
    try {
      const res = await fetch(`/api/shares/${share.id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(t('workspace.revokeShareFailed'));
      setSharedFiles((items) => items.filter((item) => item.id !== share.id));
    } catch (error) {
      toastError(
        error instanceof Error
          ? error.message
          : t('workspace.revokeShareFailed'),
      );
    }
  };
  const copySharedUrl = async (share: SharedFile) => {
    if (!share.url) return;
    const url = `${window.location.origin}${share.url}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      toastError(t('workspace.copyLinkFailed'));
    }
  };

  const switchLibraryView = (view: typeof libraryView) => {
    setLibraryView(view);
    setQuery("");
    setExpandedPaths(new Set());
    if (view === "published") setCurrentPath(`${rootPath}/published`);
    else if (view === "sharedFiles") setCurrentPath(rootPath);
    else if (view === "sharedSkills")
      setCurrentPath(`${rootPath}/.tower/skills`);
    else if (view === "projectSkills") setCurrentPath(`${rootPath}/skills`);
    else setCurrentPath(rootPath);
  };

  const switchProject = (projectId: string) => {
    const project = sortedProjects.find((p) => p.id === projectId);
    if (!project) return;
    setCapabilityProjectId(project.id);
    setSelectedProjectId(project.id);
    setQuery("");
    setLibraryView("all");
    setExpandedPaths(new Set());
    clearSelection();
    setCurrentPath(project.rootPath || "");
  };

  const openProjectInstructions = useCallback(async () => {
    if (!rootPath) return;
    const instructionsPath = `${rootPath}/AGENTS.md`;
    setInstructionsOpen(true);
    setInstructionsLoading(true);
    setInstructionsError("");
    try {
      const res = await fetch(
        `/api/files/read?path=${encodeURIComponent(instructionsPath)}`,
        { headers: authHeaders() },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error(
          data.error || t('workspace.loadInstructionsFailed') + ` (${res.status})`,
        );
      setInstructionsContent(
        typeof data.content === "string" ? data.content : "",
      );
    } catch (err) {
      console.error("[FilesWorkspace] load project instructions failed", err);
      setInstructionsContent("");
      setInstructionsError(
        err instanceof Error
          ? err.message
          : t('workspace.loadInstructionsFailed'),
      );
    } finally {
      setInstructionsLoading(false);
    }
  }, [rootPath, t]);

  const canGoUp =
    !!rootPath &&
    currentPath !== rootPath &&
    currentPath.startsWith(`${rootPath}/`);
  const parentPath = canGoUp
    ? currentPath.split("/").slice(0, -1).join("/")
    : rootPath;

  if (!selectedProject) {
    return (
      <div className="relative z-10 flex h-full flex-col items-center justify-center p-10 text-center">
        <div className="mb-3 text-5xl">📁</div>
        <h2 className="text-xl font-semibold text-gray-100">
          {t('workspace.noProjectFiles')}
        </h2>
        <p className="mt-2 max-w-md text-sm text-surface-500">
          {t('workspace.noProjectFilesDescription')}
        </p>
      </div>
    );
  }

  return (
    <div className="relative z-10 flex h-full min-h-0 flex-col bg-surface-950/80">
      <div className="shrink-0 border-b border-surface-800/80 bg-surface-950/90 px-3 py-3 backdrop-blur-xl sm:px-5 sm:py-4">
        {isMobile && (
          <div className="mb-3 flex items-center gap-2.5 rounded-xl border border-surface-800 bg-surface-900/75 p-2.5">
            <AgentIdentityAvatar project={selectedProject} variant="list" showListAccent={false} className="h-9 w-9 shrink-0 rounded-xl border border-surface-700/60" fallbackClassName="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-surface-800 text-xs" />
            <label className="min-w-0 flex-1">
              <span className="block text-[10px] font-bold uppercase tracking-[0.14em] text-surface-600">{t('workspace.currentDocumentWorkspace')}</span>
              <select
                value={selectedProject.id}
                onChange={(event) => switchProject(event.target.value)}
                className="mt-0.5 h-7 w-full truncate bg-transparent text-[15px] font-bold text-surface-100 outline-none"
                aria-label={t('workspace.selectAiTeammateForDocuments')}
              >
                {sortedProjects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.agent?.displayName || project.name}
                  </option>
                ))}
              </select>
            </label>
            <svg className="h-4 w-4 shrink-0 text-surface-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="m8 10 4 4 4-4" /></svg>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[12px] font-semibold text-surface-500">
              <span>{t('workspace.itemCount', { count: displayedEntries.length })}</span>
              <span className="h-1 w-1 rounded-full bg-surface-700" />
              <span className="truncate font-mono" title={currentPath}>
                {relativePath(currentPath, rootPath)}
              </span>
            </div>
            {!embedded && (
              <h1 className="mt-1 truncate text-2xl font-bold text-gray-100">
                {t('workspace.projectFiles')}
              </h1>
            )}
          </div>

          {!embedded && (
            <button
              onClick={openProjectInstructions}
              className="rounded-lg border border-surface-700 bg-surface-900 px-3 py-2 text-[13px] font-semibold text-surface-300 hover:border-primary-500/50 hover:text-primary-300"
              title={t('workspace.viewProjectInstructions')}
            >
              {t('workspace.projectInstructions')}
            </button>
          )}
          <div className="relative flex flex-wrap items-center gap-1.5">
            <button
              onClick={() => setCreateMenuOpen((open) => !open)}
              disabled={!!busyAction}
              aria-label={t('workspace.add')}
              title={t('workspace.add')}
              className="flex h-9 items-center justify-center gap-1.5 rounded-lg border border-surface-700 bg-surface-900 px-2.5 text-lg font-semibold text-surface-300 disabled:opacity-40"
            >
              <span aria-hidden="true">+</span><span className="hidden text-[12px] sm:inline">{t('workspace.add')}</span>
            </button>
            {createMenuOpen && (
              <>
                {isMobile && <button type="button" aria-label={t('workspace.closeAddMenu')} className="fixed inset-0 z-40 bg-black/30" onClick={() => setCreateMenuOpen(false)} />}
                <div className={`${isMobile ? "fixed inset-x-3 bottom-[max(12px,env(safe-area-inset-bottom))] z-50 rounded-2xl p-2" : "absolute right-0 top-11 z-30 w-40 rounded-lg p-1"} overflow-hidden border border-surface-700 bg-surface-900 shadow-xl`}>
                  {isMobile && <div className="px-3 pb-2 pt-1 text-[12px] font-bold text-surface-500">{t('workspace.add')}</div>}
                <button
                  onClick={() => beginCreate("file")}
                  className="block w-full rounded px-3 py-2 text-left text-xs text-surface-300 hover:bg-surface-800"
                >
                  {t('workspace.newFile')}
                </button>
                <button
                  onClick={() => beginCreate("folder")}
                  className="block w-full rounded px-3 py-2 text-left text-xs text-surface-300 hover:bg-surface-800"
                >
                  {t('workspace.newFolder')}
                </button>
                <button
                  onClick={() => {
                    setCreateMenuOpen(false);
                    fileUploadRef.current?.click();
                  }}
                  className="block w-full rounded px-3 py-2 text-left text-xs text-surface-300 hover:bg-surface-800"
                >
                  {t('workspace.uploadFiles')}
                </button>
                <button
                  onClick={() => {
                    setCreateMenuOpen(false);
                    folderUploadRef.current?.click();
                  }}
                  className="block w-full rounded px-3 py-2 text-left text-xs text-surface-300 hover:bg-surface-800"
                >
                  {t('workspace.uploadFolder')}
                </button>
                </div>
              </>
            )}
            <button
              onClick={() => searchOpen ? closeSearch() : setSearchOpen(true)}
              aria-label={searchOpen ? t('workspace.closeSearch') : t('workspace.search')}
              aria-pressed={searchOpen}
              title={searchOpen ? t('workspace.closeSearch') : t('workspace.search')}
              className={`flex h-9 items-center justify-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-semibold ${searchOpen ? "border-primary-500/40 bg-primary-500/10 text-primary-700 dark:text-primary-200" : "border-surface-700 bg-surface-900 text-surface-300"}`}
            >
              <span aria-hidden="true">⌕</span><span className="hidden sm:inline">{t('workspace.search')}</span>
            </button>
            <button
              onClick={() => selectionMode ? clearSelection() : setSelectionMode(true)}
              aria-label={selectionMode ? t('workspace.cancelSelection') : t('workspace.select')}
              aria-pressed={selectionMode}
              title={selectionMode ? t('workspace.cancelSelection') : t('workspace.select')}
              className={`flex h-9 items-center justify-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-semibold ${selectionMode ? "border-primary-500/40 bg-primary-500/10 text-primary-700 dark:text-primary-200" : "border-surface-700 bg-surface-900 text-surface-300"}`}
            >
              <span aria-hidden="true">✓</span><span className="hidden sm:inline">{selectionMode ? t('workspace.cancel') : t('workspace.select')}</span>
            </button>
            <button
              onClick={() => {
                onRequestFileTree?.(currentPath);
                void loadDirectory(currentPath);
              }}
              aria-label={t('workspace.refresh')}
              title={t('workspace.refresh')}
              className="hidden h-9 items-center rounded-lg border border-surface-700 bg-surface-900 px-2.5 text-[12px] font-semibold text-surface-300 sm:flex"
            >
              {t('workspace.refresh')}
            </button>
            {uploadProgress && <UploadProgressChip progress={uploadProgress} className="ml-1" />}
            <input
              ref={fileUploadRef}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                handleFileInput(event.target.files);
                event.target.value = "";
              }}
            />
            <input
              ref={folderUploadRef}
              type="file"
              multiple
              hidden
              {...({ webkitdirectory: "", directory: "" } as any)}
              onChange={(event) => {
                handleFileInput(event.target.files);
                event.target.value = "";
              }}
            />
          </div>
        </div>

        {(!embedded || searchOpen || query) && <div
          className={`mt-4 grid gap-3 ${embedded ? "" : "lg:grid-cols-[minmax(180px,260px)_1fr]"}`}
        >
          {!embedded && !isMobile && (
            <select
              value={selectedProject.id}
              onChange={(e) => switchProject(e.target.value)}
              className="h-10 rounded-xl border border-surface-700 bg-surface-900 px-3 text-sm font-semibold text-gray-200 outline-none focus:border-primary-500/70"
            >
              {sortedProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.pinned ? "★ " : ""}
                  {project.name}
                </option>
              ))}
            </select>
          )}

          {(searchOpen || query) && <div className="relative">
            <svg
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-surface-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-4.35-4.35m1.35-5.65a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
            <input
              ref={searchInputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(event) => { if (event.key === "Escape") closeSearch(); }}
              placeholder={t('workspace.searchProjectFiles')}
              className="h-10 w-full rounded-xl border border-surface-700 bg-surface-900 pl-9 pr-10 text-sm text-gray-200 outline-none placeholder:text-surface-600 focus:border-primary-500/70"
            />
            <button type="button" onClick={closeSearch} aria-label={t('workspace.closeSearch')} className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-2 py-1 text-xs text-surface-500 hover:text-surface-100">×</button>
          </div>}
        </div>}

        <div className="mt-2 flex items-center gap-1 overflow-x-auto border-b border-surface-800/70 pb-2 text-[13px] sm:mt-3 sm:flex-wrap">
          {(
            [
              ["all", t("workspace.allFiles")],
              ["published", t("workspace.publishedMaterials")],
              ["sharedFiles", t("workspace.sharedFiles")],
              ["projectSkills", t("workspace.createdSkills")],
              ["sharedSkills", t("workspace.sharedSkills")],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              onClick={() => switchLibraryView(value)}
              className={`shrink-0 whitespace-nowrap rounded-lg border px-2.5 py-1.5 font-semibold transition-colors sm:px-3 ${libraryView === value ? "border-primary-500/35 bg-primary-500/12 text-primary-700 dark:text-primary-200" : "border-transparent text-surface-500 hover:border-surface-700 hover:bg-surface-900 hover:text-surface-100"}`}
            >
              {label}
            </button>
          ))}
        </div>
        {selectionMode && (
          <div className="mt-2 flex items-center gap-2 rounded-lg border border-primary-500/25 bg-primary-500/8 px-3 py-2 text-xs">
            <span className="font-bold text-primary-700 dark:text-primary-200">
              {t('workspace.selectedCount', { count: selectedPaths.size })}
            </span>
            <button
              disabled={selectedPaths.size !== 1}
              onClick={() => void renameSelected()}
              className="rounded border border-surface-700 px-2 py-1 disabled:opacity-40"
            >
              {t('workspace.rename')}
            </button>
            <button
              onClick={() => void moveSelected()}
              className="rounded border border-surface-700 px-2 py-1"
            >
              {t('workspace.move')}
            </button>
            <button
              onClick={downloadSelected}
              className="rounded border border-surface-700 px-2 py-1"
            >
              {t('workspace.download')}
            </button>
            <button
              onClick={() => void copySelectedPaths()}
              className="rounded border border-surface-700 px-2 py-1"
            >
              {t('workspace.copyPath')}
            </button>
            <button
              onClick={() => void deleteSelected()}
              className="rounded border border-red-500/30 px-2 py-1 text-red-500 dark:text-red-300"
            >
              {t('workspace.delete')}
            </button>
            <select
              value={transferProjectId}
              onChange={(event) => selectTransferProject(event.target.value)}
              className="ml-auto rounded border border-surface-700 bg-surface-900 px-2 py-1 text-surface-700 dark:text-surface-300"
            >
              <option value="">{t('workspace.selectAiTeammateToSend')}</option>
              {sortedProjects
                .filter((project) => project.id !== selectedProject.id)
                .map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.agent?.displayName || project.name}
                  </option>
                ))}
            </select>
            {transferProjectId && (
              <div className="flex min-w-[240px] max-w-full items-center gap-1 overflow-x-auto rounded border border-surface-700 bg-surface-900 px-1 py-0.5">
                <button type="button" disabled={!transferParentDirectory} onClick={() => transferParentDirectory && navigateTransferDirectory(transferParentDirectory)} className="min-h-8 shrink-0 rounded px-2 text-surface-500 hover:bg-surface-800 hover:text-surface-200 disabled:opacity-30" aria-label={t('workspace.parentFolder')}>←</button>
                <button type="button" onClick={() => navigateTransferDirectory(transferProjectRoot)} className="min-h-8 shrink-0 rounded px-2 text-xs font-semibold text-surface-300 hover:bg-surface-800">{t('workspace.workspaceRoot')}</button>
                {transferDirectoriesLoading ? <span className="px-2 text-xs text-surface-500">{t('workspace.loading')}</span> : transferDirectories.map((directory) => <button key={directory.path} type="button" onClick={() => navigateTransferDirectory(directory.path)} className="min-h-8 shrink-0 rounded px-2 text-xs text-surface-400 hover:bg-surface-800 hover:text-surface-100">📁 {directory.name}</button>)}
                <span className="ml-auto max-w-[180px] shrink-0 truncate px-2 font-mono text-[10px] text-surface-600" title={transferDirectory}>{transferDirectory.slice(transferProjectRoot.length).replace(/^\/+/, "") || "/"}</span>
              </div>
            )}
            <button
              disabled={!transferProjectId || !transferDirectory || busyAction === "copy"}
              onClick={() => void copySelectedToProject()}
              className="rounded border border-primary-500/30 px-2 py-1 font-bold text-primary-700 disabled:opacity-40 dark:text-primary-200"
            >
              {t('workspace.copyAndSend')}
            </button>
            <button
              onClick={clearSelection}
              className="px-2 py-1 text-surface-600"
            >
              {t('workspace.cancelSelection')}
            </button>
          </div>
        )}
        {fileHistory.length > 0 && (
          <div className="mt-2 flex items-center gap-2 overflow-x-auto text-[11px] text-surface-600">
            <span className="font-semibold">{t('workspace.recentActions')}</span>
            {fileHistory.map((item, index) => (
              <span
                key={`${item.label}-${index}`}
                className="whitespace-nowrap rounded bg-surface-900 px-2 py-1"
              >
                {item.label}
                {index === 0 && item.undo && (
                  <button
                    onClick={() =>
                      void item.undo!()
                        .then(() =>
                          setFileHistory((history) => history.slice(1)),
                        )
                        .catch((error) =>
                          toastError(error.message || t('workspace.undoFailed')),
                        )
                    }
                    className="ml-2 font-bold text-primary-700 dark:text-primary-300"
                  >
                    {t('workspace.undo')}
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
        <div className="mt-2 flex min-w-0 items-center gap-2 overflow-x-auto text-[13px]">
          <button
            disabled={!canGoUp}
            onClick={() => {
              setQuery("");
              setExpandedPaths(new Set());
              clearSelection();
              if (parentPath === rootPath) setLibraryView("all");
              setCurrentPath(parentPath);
            }}
            className="shrink-0 rounded-lg border border-surface-800 bg-surface-900/80 px-2.5 py-1.5 font-semibold text-surface-700 dark:text-surface-300 disabled:cursor-not-allowed disabled:opacity-35 hover:enabled:border-surface-600 hover:enabled:text-gray-200"
          >
            ↑ {t('workspace.parentFolder')}
          </button>
          <div className="flex min-w-max flex-1 items-center gap-1 text-surface-500 sm:min-w-0 sm:flex-wrap">
            {breadcrumbs.map((crumb, index) => (
              <React.Fragment key={crumb.path}>
                {index > 0 && <span className="text-surface-700">/</span>}
                <button
                  onClick={() => {
                    setQuery("");
                    setCurrentPath(crumb.path);
                  }}
                  className="max-w-[220px] truncate rounded-md px-1.5 py-1 text-surface-300 hover:bg-surface-800 hover:text-primary-300"
                >
                  {crumb.label}
                </button>
              </React.Fragment>
            ))}
          </div>
          <select
            value={kindFilter}
            onChange={(event) =>
              setKindFilter(event.target.value as typeof kindFilter)
            }
            className="hidden shrink-0 rounded-lg border border-surface-800 bg-surface-900/80 px-2.5 py-1.5 font-semibold text-surface-700 dark:text-surface-300 outline-none sm:block"
          >
            <option value="all">{t('workspace.all')}</option>
            <option value="folders">{t('workspace.foldersOnly')}</option>
            <option value="files">{t('workspace.filesOnly')}</option>
          </select>
          <button
            onClick={toggleShowHidden}
            className={`hidden shrink-0 rounded-lg border px-2.5 py-1.5 font-semibold transition-colors sm:block ${showHidden ? "border-primary-500/40 bg-primary-500/10 text-primary-700 dark:text-primary-200" : "border-surface-800 bg-surface-900/80 text-surface-500 hover:border-surface-700 hover:bg-surface-900 hover:text-surface-100"}`}
            title={showHidden ? t('workspace.hideHiddenFiles') : t('workspace.showHiddenFiles')}
            aria-pressed={showHidden}
          >
            {showHidden ? t('workspace.hiddenFilesShown') : t('workspace.showHiddenFiles')}
          </button>
        </div>
      </div>

      {instructionsOpen && !embedded && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onClick={() => setInstructionsOpen(false)}
        >
          <div
            className="flex max-h-[86vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-surface-700 bg-surface-950 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-surface-800 px-5 py-4">
              <div className="min-w-0">
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary-300">
                  Project Instructions
                </div>
                <h2 className="mt-1 text-lg font-bold text-gray-100">
                  {t('workspace.projectInstructions')}
                </h2>
                <p className="mt-1 text-sm text-surface-500">
                  {t('workspace.instructionsDescription')}
                </p>
              </div>
              <button
                onClick={() => setInstructionsOpen(false)}
                className="rounded-lg border border-surface-700 bg-surface-900 px-3 py-1.5 text-sm font-semibold text-surface-300 hover:text-gray-100"
              >
                {t('workspace.close')}
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
              {instructionsLoading ? (
                <div className="py-16 text-center text-sm text-surface-500">
                  {t('workspace.loadingInstructions')}
                </div>
              ) : instructionsError ? (
                <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
                  <div className="font-semibold">
                    {t('workspace.openInstructionsFailed')}
                  </div>
                  <div className="mt-1 text-red-200/80">
                    {instructionsError}
                  </div>
                </div>
              ) : instructionsContent ? (
                <MarkdownReadSurface
                  content={instructionsContent}
                  components={{}}
                  className="prose prose-invert prose-sm max-w-none markdown-document"
                />
              ) : (
                <div className="rounded-xl border border-surface-800 bg-surface-900/70 p-4 text-sm text-surface-400">
                  {t('workspace.noInstructions')}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div
        className="min-h-0 flex-1 overflow-auto p-5"
        onDragEnter={(event) => {
          if (
            !event.dataTransfer.types.includes("application/x-filetree-move")
          ) {
            event.preventDefault();
            setDropActive(true);
          }
        }}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setDropActive(false);
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("application/x-filetree-move"))
            event.preventDefault();
        }}
        onDrop={(event) => {
          if (event.dataTransfer.types.includes("application/x-filetree-move"))
            return;
          event.preventDefault();
          setDropActive(false);
          void readDroppedItems(event.dataTransfer).then(uploadItems);
        }}
      >
        {dropActive && (
          <div className="pointer-events-none absolute inset-4 z-20 grid place-items-center rounded-xl border-2 border-dashed border-primary-500 bg-primary-500/10 text-sm font-bold text-primary-700 dark:text-primary-200">
            {t('workspace.dropHere')}
          </div>
        )}
        {libraryView === "sharedFiles" && (
          <section className="mb-4 overflow-hidden rounded-xl border border-surface-800 bg-surface-900/60">
            <div className="grid grid-cols-[minmax(0,1fr)_100px_130px_auto] border-b border-surface-800 bg-surface-900 px-3 py-2 text-[11px] font-bold text-surface-500">
              <span>{t('workspace.sharedFiles')}</span>
              <span>{t('workspace.status')}</span>
              <span>{t('workspace.expires')}</span>
              <span>{t('workspace.actions')}</span>
            </div>
            {sharesLoading ? (
              <div className="px-3 py-5 text-sm text-surface-500">
                {t('workspace.loadingSharedFiles')}
              </div>
            ) : sharedFiles.length === 0 ? (
              <div className="px-3 py-8 text-center text-sm text-surface-500">
                {t('workspace.noSharedLinks')}
              </div>
            ) : (
              sharedFiles.map((share) => (
                <div
                  key={share.id}
                  className="grid grid-cols-[minmax(0,1fr)_100px_130px_auto] items-center gap-2 border-b border-surface-800/50 px-3 py-2 last:border-0"
                >
                  <button
                    onClick={() => onFileClick(share.file_path)}
                    className="min-w-0 text-left"
                  >
                    <span className="block truncate text-sm font-semibold text-surface-200">
                      {share.fileName || share.name}
                    </span>
                    <span className="block truncate text-[11px] text-surface-600">
                      {relativePath(share.file_path, rootPath)}
                    </span>
                  </button>
                  <span
                    className={`text-xs font-semibold ${share.expired || share.revoked ? "text-red-300" : "text-emerald-300"}`}
                  >
                    {share.revoked ? t('workspace.revoked') : share.expired ? t('workspace.expired') : t('workspace.valid')}
                  </span>
                  <span className="text-xs text-surface-500">
                    {share.expires_at
                      ? formatModified(share.expires_at)
                      : t('workspace.noExpiry')}
                  </span>
                  <div className="flex gap-1">
                    <button
                      onClick={() => void copySharedUrl(share)}
                      disabled={!share.url}
                      className="rounded border border-surface-700 px-2 py-1 text-[11px] text-surface-300 disabled:opacity-40"
                    >
                      {t('workspace.copy')}
                    </button>
                    <button
                      onClick={() => void revokeSharedFile(share)}
                      className="rounded border border-red-500/25 px-2 py-1 text-[11px] text-red-300"
                    >
                      {t('workspace.revoke')}
                    </button>
                  </div>
                </div>
              ))
            )}
          </section>
        )}
        {libraryView === "published" &&
          (publishLoading || publishedSites.length > 0) && (
            <section className="mb-4 overflow-hidden rounded-xl border border-surface-800 bg-surface-900/60">
              <div className="border-b border-surface-800 px-3 py-2 text-[11px] font-bold text-surface-500">
                LIVE PUBLISHING
              </div>
              {publishLoading ? (
                <div className="px-3 py-4 text-sm text-surface-500">
                  {t('workspace.loadingPublished')}
                </div>
              ) : (
                publishedSites.map((site) => (
                  <div
                    key={site.slug || site.name}
                    className="grid grid-cols-[minmax(0,1fr)_90px_120px_auto] items-center gap-3 border-b border-surface-800/60 px-3 py-2 last:border-0"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-surface-200">
                        {site.name}
                      </div>
                      <div className="truncate text-[11px] text-surface-600">
                        {site.external_url || site.slug}
                      </div>
                    </div>
                    <span className="text-xs text-surface-500">
                      {site.access || "unlisted"}
                    </span>
                    <span className="text-xs text-surface-500">
                      {formatModified(site.last_deployed_at || site.created_at)}
                    </span>
                    <div className="flex gap-1.5">
                      <button
                        onClick={() => {
                          const source = `${rootPath}/published/${site.slug || site.name}/index.html`;
                          onFileClick(source);
                        }}
                        className="rounded border border-surface-700 px-2 py-1 text-[11px] font-semibold text-surface-400 hover:text-primary-200"
                      >
                        HTML
                      </button>
                      {site.external_url && (
                        <button
                          onClick={() =>
                            window.open(
                              site.external_url,
                              "_blank",
                              "noopener,noreferrer",
                            )
                          }
                          className="rounded border border-primary-500/30 bg-primary-500/10 px-2 py-1 text-[11px] font-semibold text-primary-300"
                        >
                          {t('workspace.live')}
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </section>
          )}
        {libraryView === "sharedFiles" ? null : loading ? (
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-6 2xl:grid-cols-8">
            {Array.from({ length: 12 }).map((_, i) => (
              <div
                key={i}
                className="h-16 animate-pulse rounded-xl border border-surface-800 bg-surface-900/60"
              />
            ))}
          </div>
        ) : displayedEntries.length === 0 &&
          libraryView === "published" &&
          publishedSites.length > 0 ? null : displayedEntries.length === 0 ? (
          <div className="flex h-full min-h-[180px] flex-col items-center justify-center rounded-2xl border border-dashed border-surface-800 bg-surface-900/20 text-center">
            <div className="mb-3 text-4xl">{query ? "🔎" : "📂"}</div>
            <div className="text-lg font-semibold text-gray-200">
              {query
                ? t('workspace.noSearchResults')
                : libraryView === "projectSkills"
                  ? t('workspace.noProjectSkills')
                  : libraryView === "sharedSkills"
                    ? t('workspace.noSharedSkills')
                    : libraryView === "published"
                      ? t('workspace.noPublishedMaterials')
                      : t('workspace.emptyFolder')}
            </div>
            <div className="mt-1 text-sm text-surface-500">
              {query
                ? t('workspace.searchHint')
                : libraryView === "published"
                  ? t('workspace.publishedHint')
                  : libraryView === "projectSkills"
                    ? t('workspace.projectSkillsHint')
                    : libraryView === "sharedSkills"
                      ? t('workspace.sharedSkillsHint')
                      : t('workspace.emptyFolderHint')}
            </div>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-surface-800 bg-surface-900/45">
            <div className="grid grid-cols-[minmax(0,1fr)_72px] border-b border-surface-800 bg-surface-900 px-3 py-1.5 text-[11px] font-bold text-surface-600 sm:grid-cols-[minmax(0,1fr)_90px_100px_126px]">
              <button
                className={`text-left hover:text-primary-300 ${fileSortMode === "name" ? "text-primary-300" : ""}`}
                onClick={() => setFileSortMode("name")}
              >
                {t('workspace.name')} {fileSortMode === "name" ? "↓" : ""}
              </button>
              <span className="hidden sm:block">{t('workspace.size')}</span>
              <button
                className={`hidden text-left hover:text-primary-300 sm:block ${fileSortMode === "type" ? "text-primary-300" : ""}`}
                onClick={() => setFileSortMode("type")}
              >
                {t('workspace.type')} {fileSortMode === "type" ? "↓" : ""}
              </button>
              <button
                className={`text-right hover:text-primary-300 sm:text-left ${fileSortMode === "modified" ? "text-primary-300" : ""}`}
                onClick={() => setFileSortMode("modified")}
              >
                {t('workspace.modifiedDate')} {fileSortMode === "modified" ? "↓" : ""}
              </button>
            </div>
            {inlineCreate && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitCreate();
                }}
                className="flex items-center gap-2 border-b border-primary-500/25 bg-primary-500/5 px-3 py-2"
              >
                <span
                  className="max-w-[260px] truncate text-xs font-semibold text-primary-700 dark:text-primary-300"
                  title={inlineCreateTargetPath || currentPath}
                >
                  {inlineCreate === "folder" ? t('workspace.newFolder') : t('workspace.newFile')}
                  <span className="ml-1 font-normal text-surface-500">
                    @ {relativePath(inlineCreateTargetPath || currentPath, rootPath)}
                  </span>
                </span>
                <input
                  autoFocus
                  value={inlineCreateName}
                  onChange={(event) => setInlineCreateName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") cancelCreate();
                  }}
                  placeholder={
                    inlineCreate === "folder" ? t('workspace.folderName') : t('workspace.fileName')
                  }
                  className="min-w-0 flex-1 rounded border border-surface-700 bg-surface-950 px-2 py-1 text-sm text-surface-200 outline-none focus:border-primary-500"
                />
                <button
                  disabled={!inlineCreateName.trim()}
                  className="rounded border border-primary-500/30 px-2 py-1 text-xs font-bold text-primary-700 disabled:opacity-40 dark:text-primary-300"
                >
                  {t('workspace.create')}
                </button>
                <button
                  type="button"
                  onClick={cancelCreate}
                  className="px-2 py-1 text-xs text-surface-500"
                >
                  {t('workspace.cancel')}
                </button>
              </form>
            )}
            {outlineRows.map(({ entry, depth }) => (
              <div key={entry.path} data-files-workspace-path={entry.path} className="group relative">
                <input
                  type="checkbox"
                  aria-label={t('workspace.selectEntry', { name: entry.name })}
                  checked={selectedPaths.has(entry.path)}
                  onChange={() => toggleSelection(entry.path)}
                  onClick={(event) => event.stopPropagation()}
                  className={`absolute left-1.5 top-2 z-10 h-3.5 w-3.5 transition-opacity ${selectionMode ? "opacity-100" : "pointer-events-none opacity-0"}`}
                />
                <button
                  {...dragProps(entry)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setContextMenu({
                      x: event.clientX,
                      y: event.clientY,
                      entry,
                    });
                  }}
                  {...folderDropProps(entry)}
                  onClick={(event) => activateEntry(entry, event)}
                  className={`grid w-full grid-cols-[minmax(0,1fr)_72px] items-center border-b px-3 py-2 text-left last:border-b-0 sm:grid-cols-[minmax(0,1fr)_90px_100px_126px] sm:py-1.5 ${dragOverPath === entry.path ? "relative z-30 border-primary-500 bg-primary-500/15 ring-2 ring-inset ring-primary-500/70" : "border-surface-800/45 hover:bg-surface-800/65"}`}
                  title={
                    dragOverPath === entry.path
                      ? t('workspace.dropOnFolder', { name: entry.name })
                      : entry.path
                  }
                  aria-label={
                    dragOverPath === entry.path
                      ? t('workspace.dropFilesOnFolder', { name: entry.name })
                      : entry.name
                  }
                >
                  <span
                    className="flex min-w-0 items-center gap-1.5"
                    style={{ paddingLeft: `${(isMobile ? 4 : 22) + depth * (isMobile ? 14 : 18)}px` }}
                  >
                    {entry.isDirectory ? (
                      <span
                        className={`w-3 shrink-0 text-[11px] text-surface-600 transition-transform ${expandedPaths.has(entry.path) ? "rotate-90" : ""}`}
                      >
                        ›
                      </span>
                    ) : (
                      <span className="w-3" />
                    )}
                    <span className="grid h-4 w-4 shrink-0 place-items-center text-surface-500">
                      <FileGlyph entry={entry} />
                    </span>
                    <span className="truncate text-[13px] font-medium text-surface-200">
                      {entry.name}
                    </span>
                    {dragOverPath === entry.path && (
                      <span className="shrink-0 rounded bg-primary-600 px-1.5 py-0.5 text-[10px] font-bold text-white dark:bg-primary-500 dark:text-surface-950">
                        {t('workspace.dropInThisFolder')}
                      </span>
                    )}
                  </span>
                  <span className="hidden text-[12px] text-surface-500 sm:block">
                    {entrySizeLabel(entry)}
                  </span>
                  <span className="hidden truncate text-[12px] text-surface-500 sm:block">
                    {entry.isDirectory
                      ? t('workspace.folder')
                      : entry.extension ||
                        entry.name.split(".").pop() ||
                        t('workspace.file')}
                  </span>
                  <span className="truncate text-right text-[11px] text-surface-600 sm:text-left sm:text-[12px] sm:text-surface-500">
                    {formatModified(entry.modified)}
                  </span>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {contextMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setContextMenu(null)}
            onContextMenu={(event) => event.preventDefault()}
          />
          <ViewportContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            className="fixed z-50 w-44 max-h-[calc(100vh-1rem)] overflow-y-auto rounded-lg border border-surface-700 bg-surface-900 p-1 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              onClick={() => {
                openEntry(contextMenu.entry);
                setContextMenu(null);
              }}
              className="block w-full rounded px-3 py-2 text-left text-xs text-surface-300 hover:bg-surface-800"
            >
              {contextMenu.entry.isDirectory ? t('workspace.expandCollapse') : t('workspace.open')}
            </button>
            {contextMenu.entry.isDirectory && (
              <>
                <button
                  onClick={() => {
                    beginCreate("folder", contextMenu.entry.path);
                    setContextMenu(null);
                  }}
                  className="block w-full rounded px-3 py-2 text-left text-xs text-surface-300 hover:bg-surface-800"
                >
                  {t('workspace.newFolderHere')}
                </button>
                <button
                  onClick={() => {
                    beginCreate("file", contextMenu.entry.path);
                    setContextMenu(null);
                  }}
                  className="block w-full rounded px-3 py-2 text-left text-xs text-surface-300 hover:bg-surface-800"
                >
                  {t('workspace.newFileHere')}
                </button>
                <button
                  onClick={() => {
                    setQuery("");
                    setCurrentPath(contextMenu.entry.path);
                    setContextMenu(null);
                  }}
                  className="block w-full rounded px-3 py-2 text-left text-xs text-surface-300 hover:bg-surface-800"
                >
                  {t('workspace.moveToFolder')}
                </button>
              </>
            )}
            <button
              onClick={() => {
                setSelectedPaths(new Set([contextMenu.entry.path]));
                setSelectionMode(true);
                setContextMenu(null);
              }}
              className="block w-full rounded px-3 py-2 text-left text-xs text-surface-300 hover:bg-surface-800"
            >
              {t('workspace.selectionActions')}
            </button>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(contextMenu.entry.path);
                setContextMenu(null);
              }}
              className="block w-full rounded px-3 py-2 text-left text-xs text-surface-300 hover:bg-surface-800"
            >
              {t('workspace.copyPath')}
            </button>
          </ViewportContextMenu>
        </>
      )}
      {isOperatorOrAdmin() && rootPath && (
        <div className="shrink-0 border-t border-surface-800/80 bg-surface-950/90 px-5 py-2 text-[12px] text-surface-600">
          {t('workspace.currentPath')}:{" "}
          <span className="font-mono text-surface-400">{currentPath}</span>
        </div>
      )}
    </div>
  );
}
