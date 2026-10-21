import React, {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useMemo,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useConfirm } from "../../hooks/useDialog";
import type { SessionMeta } from "../../stores/session-store";
import { useSessionStore } from "../../stores/session-store";
import { useChatStore } from "../../stores/chat-store";
import { useFileStore } from "../../stores/file-store";
import type { Project } from "../../stores/project-store";
import { toastSuccess, toastError } from "../../utils/toast";
import { prefetchSessionMessages } from "../../features/session-prefetch/prefetchSessionMessages";
import { RelatedSessionsPopover } from "./RelatedSessionsPopover";
import { getCurrentRole } from "../../utils/auth";
import { RunIndicator } from "../common/RunIndicator";
import {
  deriveSessionRowActivity,
  deriveSessionRowState,
} from "../../features/session-run-state/session-row-state";
import { useSettingsStore } from "../../stores/settings-store";
import { AgentIdentityAvatar } from "../../features/agent-profile/AgentIdentityAvatar";
import { serverNowMs } from "../../utils/server-clock";
import { AgentSessionBadge } from "../../features/agent-sessions/AgentSessionBadge";
import { FadeOverflowText } from "../common/FadeOverflowText";

const LONG_CONTEXT_MODEL_USED = "litellm-responses/smartest-long";

function isLongContextSessionModel(modelUsed?: string | null): boolean {
  return (
    modelUsed === LONG_CONTEXT_MODEL_USED ||
    modelUsed === `pi:${LONG_CONTEXT_MODEL_USED}`
  );
}

function AwaitingUserMark() {
  const { t } = useTranslation('layout');
  return (
    <span
      className="tone-pill tone-warning inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[12px] font-bold leading-none"
      aria-label={t('awaitingAnswer')}
      title={t('aiQuestionNeedsAnswer')}
    >
      ?
    </span>
  );
}

function relativeTime(dateStr: string): string {
  // Ensure UTC parse: handle "YYYY-MM-DD HH:mm:ss", "...T..." without Z, and full ISO strings
  let normalized = dateStr.includes("T") ? dateStr : dateStr.replace(" ", "T");
  if (!normalized.endsWith("Z") && !/[+-]\d{2}(:\d{2})?$/.test(normalized))
    normalized += "Z";
  const diff = Date.now() - new Date(normalized).getTime();
  if (isNaN(diff)) return "";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = diff / 3600000;
  if (hours < 24) return `${Math.round(hours * 10) / 10}h`;
  const days = hours / 24;
  if (days < 30) return `${Math.round(days * 10) / 10}d`;
  return new Date(normalized).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function elapsedTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

/* ── Context Menu (fixed positioning, outside-click close) ── */

function SessionContextMenu({
  x,
  y,
  session,
  onRename,
  onToggleFavorite,
  onDelete,
  onClose,
  canDelete,
  canManageVisibility = false,
  onShowRelated,
  onSelect,
  mobile = false,
  deleteActionLabel,
  deleteActionIcon = "trash",
}: {
  x: number;
  y: number;
  session: SessionMeta;
  onRename: () => void;
  onToggleFavorite: () => void;
  onDelete: () => void;
  onClose: () => void;
  canDelete?: boolean;
  canManageVisibility?: boolean;
  onShowRelated?: () => void;
  onSelect: (session: SessionMeta) => void;
  mobile?: boolean;
  deleteActionLabel?: string;
  deleteActionIcon?: "trash" | "archive" | "down";
}) {
  const { t } = useTranslation("layout");
  const confirm = useConfirm();
  const ref = useRef<HTMLDivElement>(null);
  const [adjustedPos, setAdjustedPos] = useState({ left: x, top: y });
  const [deckMenu, setDeckMenu] = useState<{ x: number; y: number } | null>(null);

  // Adjust position to stay within viewport (runs once on mount, before paint)
  useLayoutEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const pad = 8;
    const newTop =
      rect.bottom > window.innerHeight - pad
        ? Math.max(pad, window.innerHeight - rect.height - pad)
        : y;
    const newLeft =
      rect.right > window.innerWidth - pad
        ? Math.max(pad, window.innerWidth - rect.width - pad)
        : x;
    setAdjustedPos({ left: newLeft, top: newTop });
  }, [x, y]);

  useEffect(() => {
    const handler = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("touchstart", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("touchstart", handler);
    };
  }, [onClose]);

  const itemClass =
    "w-full min-h-[34px] flex items-center gap-2.5 px-3 py-1 text-[14px] text-gray-300 hover:bg-primary-600/30 hover:text-white transition-colors text-left";

  return createPortal(
    <>
      {mobile && (
        <div
          className="fixed inset-0 z-40 bg-black/25"
          onClick={onClose}
          aria-hidden="true"
        />
      )}
      <div
        ref={ref}
        role="menu"
        aria-label={t("sessionActions")}
        className={
          mobile
            ? "fixed right-2 bottom-[calc(env(safe-area-inset-bottom,0px)+0.5rem)] z-50 w-[min(18rem,calc(100vw-1rem))] max-h-[82vh] overflow-y-auto overscroll-contain bg-surface-800 border border-surface-700 rounded-2xl shadow-2xl py-2"
            : "fixed z-50 max-h-[calc(100vh-1rem)] overflow-y-auto overscroll-contain bg-surface-800 border border-surface-700 rounded-lg shadow-xl py-1 min-w-[180px]"
        }
        style={
          mobile
            ? undefined
            : {
                ...adjustedPos,
                maxHeight: `calc(100vh - ${adjustedPos.top + 8}px)`,
              }
        }
        onClick={(e) => e.stopPropagation()}
      >
        {/* Rename */}
        <button
          className={itemClass}
          onClick={() => {
            onRename();
            onClose();
          }}
        >
          <svg
            className="w-3.5 h-3.5 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
            />
          </svg>
          {t("rename")}
        </button>
        {/* Toggle pin */}
        <button
          className={itemClass}
          onClick={() => {
            onToggleFavorite();
            onClose();
          }}
        >
          <svg
            className="w-3.5 h-3.5 text-surface-400"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M16 3.5v5.1l2.3 2.3c.45.45.13 1.2-.5 1.2h-4.55v7.15a.75.75 0 01-1.5 0V12.1H7.2c-.63 0-.95-.75-.5-1.2L9 8.6V3.5H7.75a.75.75 0 010-1.5h8.5a.75.75 0 010 1.5H16z" />
          </svg>
          {session.favorite ? t("removeFavorite") : t("favorite")}
        </button>
        {/* AI final-response subscription */}
        <button
          className={itemClass}
          onClick={async () => {
            const subscribed = session.currentUserSubscribed !== true;
            const ok = await useSessionStore.getState().setSessionSubscription(session.id, subscribed);
            if (!ok) toastError(t("sessionSubscriptionFailed"));
            onClose();
          }}
        >
          <svg className="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 10-12 0v3.2c0 .5-.2 1-.6 1.4L4 17h5m6 0a3 3 0 01-6 0" />
          </svg>
          {session.currentUserSubscribed === true ? t("stopNewAnswerNotifications") : t("receiveNewAnswers")}
        </button>
        {/* Visibility toggle */}
        {session.projectId && canManageVisibility && (
          <button
            className={itemClass}
            onClick={async () => {
              const newVis =
                session.visibility === "project" ? "private" : "project";
              if (!await confirm({
                title: t(newVis === "private" ? "makePrivate" : "makeShared"),
                message: t(newVis === "private" ? "privateVisibilityWarning" : "sharedVisibilityWarning"),
              })) return;
              const tk = localStorage.getItem("token");
              const hdrs: Record<string, string> = {
                "Content-Type": "application/json",
              };
              if (tk) hdrs["Authorization"] = `Bearer ${tk}`;
              fetch(`/api/sessions/${session.id}`, {
                method: "PATCH",
                headers: hdrs,
                body: JSON.stringify({ visibility: newVis }),
              })
                .then((res) => {
                  if (res.ok) {
                    useSessionStore
                      .getState()
                      .updateSessionMeta(session.id, { visibility: newVis });
                  }
                })
                .catch(() => {
                  console.warn("[session] visibility update failed");
                });
              onClose();
            }}
          >
            {session.visibility === "project" ? (
              <svg
                className="w-3.5 h-3.5 text-gray-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                />
              </svg>
            ) : (
              <svg
                className="w-3.5 h-3.5 text-gray-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                />
              </svg>
            )}
            {session.visibility === "project"
              ? t("makePrivate")
              : t("shareWithProject")}
          </button>
        )}
        {/* Copy link */}
        <button
          className={itemClass}
          onClick={async () => {
            try {
              const origin = window.location.origin;
              await navigator.clipboard.writeText(`${origin}/s/${session.id}`);
              onClose();
            } catch {}
          }}
        >
          <svg
            className="w-3.5 h-3.5 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
            />
          </svg>
          {t("copyLink")}
        </button>
        {/* Related sessions (Level 1 backlinks — same-file heuristic) */}
        {onShowRelated && (
          <button
            className={itemClass}
            onClick={() => {
              onShowRelated();
              onClose();
            }}
          >
            <svg
              className="w-3.5 h-3.5 text-gray-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4 6h16M4 12h16M4 18h7"
              />
            </svg>
            {t("relatedSessions")}
          </button>
        )}
        {/* Duplicate — clone the session (DB rows + .jsonl) so context-up-to-now is preserved.
          Keep all non-deck actions above the deck picker so long deck lists cannot
          push them below the visible viewport.
          See: workspace/decisions/2026-04-28-session-clone.md */}
        <button
          className={itemClass}
          onClick={async () => {
            onClose();
            try {
              const tk = localStorage.getItem("token");
              const hdrs: Record<string, string> = {
                "Content-Type": "application/json",
              };
              if (tk) hdrs["Authorization"] = `Bearer ${tk}`;
              const res = await fetch(`/api/sessions/${session.id}/clone`, {
                method: "POST",
                headers: hdrs,
              });
              if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(
                  data.error || t("cloneFailedStatus", { status: res.status }),
                );
              }
              const { session: clone } = await res.json();
              // Optimistic add to sidebar, then route through the same session
              // selection path as a normal click. That path updates the sidebar
              // selection, chat-store session id, WebSocket active session, message
              // loading, and chat tab together; setting only activeSessionId here
              // left the UI in a split-brain state after clone.
              useSessionStore.getState().addSession(clone);
              onSelect(clone);
              toastSuccess(t("sessionCloned"));
            } catch (e: any) {
              toastError(e.message || t("sessionCloneFailed"));
            }
          }}
        >
          <svg
            className="w-3.5 h-3.5 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
            />
          </svg>
          {t("duplicate")}
        </button>
        {/* Divider */}
        <div className="border-t border-surface-700/50 my-1" />
        {/* Web share — create 24h external snapshot link */}
        <button
          className={itemClass}
          onClick={async () => {
            onClose();
            try {
              const tk = localStorage.getItem("token");
              const hdrs: Record<string, string> = {
                "Content-Type": "application/json",
              };
              if (tk) hdrs["Authorization"] = `Bearer ${tk}`;
              const res = await fetch("/api/session-shares", {
                method: "POST",
                headers: hdrs,
                body: JSON.stringify({
                  shareType: "external",
                  sessionId: session.id,
                  expiresIn: "24h",
                }),
              });
              if (!res.ok)
                throw new Error(
                  (await res.json().catch(() => ({}))).error ||
                    t("common:failed"),
                );
              const data = await res.json();
              const fullUrl = `${window.location.origin}${data.url}`;
              await navigator.clipboard.writeText(fullUrl);
              toastSuccess(t("shareLinkCopied"));
            } catch (e: any) {
              toastError(e.message || t("shareLinkFailed"));
            }
          }}
        >
          <svg
            className="w-3.5 h-3.5 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"
            />
          </svg>
          {t("webShare")}
        </button>
        {/* Archive (reversible) — existing session mutation authority applies */}
        {canDelete !== false && (
          <button
            className={itemClass}
            onClick={() => {
              onDelete();
              onClose();
            }}
          >
            {deleteActionIcon === "down" ? (
              <svg
                className="w-3.5 h-3.5 text-gray-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            ) : (
              <svg
                className="w-3.5 h-3.5 text-gray-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d={deleteActionIcon === "archive"
                    ? "M3 3h18v5H3zM5 8v13h14V8M9 12h6"
                    : "M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6"}
                />
              </svg>
            )}
            {deleteActionLabel ?? t("deleteSession")}
          </button>
        )}
        <div className="my-1 border-t border-surface-700/50" />
        <button
          className={itemClass}
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            setDeckMenu({ x: rect.right + 4, y: rect.top });
          }}
          aria-haspopup="menu"
          aria-expanded={Boolean(deckMenu)}
        >
          <svg className="h-3.5 w-3.5 shrink-0 text-primary-500/60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z" /></svg>
          <span className="min-w-0 flex-1 truncate text-left">{t("moveToDeck")}</span>
          <span className="max-w-[110px] truncate text-[11px] text-surface-600">{session.label || t("defaultDeck")}</span>
          <span className="text-surface-600">›</span>
        </button>
        {deckMenu && <SessionDeckSubmenu x={deckMenu.x} y={deckMenu.y} session={session} onClose={() => setDeckMenu(null)} onComplete={onClose} />}
      </div>
    </>,
    document.body,
  );
}

/* ── Session Item ── */

interface SessionItemProps {
  session: SessionMeta;
  isActive: boolean;
  currentUsername?: string;
  onSelect: (session: SessionMeta) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onToggleFavorite: (id: string, favorite: boolean) => void;
  onMoveToProject?: (sessionId: string, projectId: string | null) => void;
  projects?: Project[];
  deleteActionLabel?: string;
  deleteActionIcon?: "trash" | "archive" | "down";
  showAgentAvatar?: boolean;
  recentInbox?: boolean;
  compactMetaAtNarrowWidth?: boolean;
}

export function SessionItem({
  session,
  isActive,
  currentUsername,
  onSelect,
  onDelete,
  onRename,
  onToggleFavorite,
  projects,
  deleteActionLabel,
  deleteActionIcon = "trash",
  showAgentAvatar = false,
  recentInbox = false,
  compactMetaAtNarrowWidth = false,
}: SessionItemProps) {
  const { t } = useTranslation("layout");
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(session.name);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    presentation: "pointer" | "sheet";
  } | null>(null);
  const [relatedPopover, setRelatedPopover] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [isHovered, setIsHovered] = useState(false);
  // Permission: only admin or session owner can delete. Role from JWT (utils/auth.ts).
  const userRole = useMemo(() => getCurrentRole() || "", []);
  const canDelete =
    userRole === "admin" ||
    !session.ownerUsername ||
    session.ownerUsername === currentUsername;
  // On touch devices, hover/right-click/long-press are unreliable. Expose an explicit
  // trailing action button instead, and keep long-press out of the scroll path.
  const isTouchDevice = useRef(
    typeof window !== "undefined" &&
      ("ontouchstart" in window || navigator.maxTouchPoints > 0),
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const isStreaming = useSessionStore((s) =>
    s.streamingSessions.has(session.id),
  );
  const isUnreadAttention = session.unreadAiResponse === true;
  const queueCount = useChatStore(
    (s) => (s.messageQueue[session.id] ?? []).length,
  );
  const turnState = useChatStore((s) => s.turnStateBySession[session.id]);
  const turnPhase = turnState?.phase || "idle";
  const markTurnRead = useChatStore((s) => s.markTurnRead);
  const activity = deriveSessionRowActivity({
    isStreaming,
    phase: turnPhase,
    queueCount,
    summary: turnState?.activeToolSummary || turnState?.activeToolName,
  });
  const rowState = deriveSessionRowState(activity, isUnreadAttention);
  const isKanbanTask =
    session.label === "task" ||
    session.name.startsWith("[task]") ||
    session.name.startsWith("\u{1F7E2}"); // persisted Task Run or legacy naming
  const isChannelAi = session.label === "channel_ai"; // 🤖
  const isProactive = session.label === "proactive"; // 💬
  const isDeploymentSession =
    (session as SessionMeta & { kind?: string }).kind === "deployment" ||
    session.label === "배포 세션";
  // Channel AI sessions belong to rooms and must not be hidden from the plain
  // session sidebar. Agent backing sessions, however, are now first-class
  // sessions: hiding them means archive/hide the session row and archive the
  // linked worker registry entry server-side.
  // 결정: workspace/decisions/2026-05-23-channel-ai-session-isolation.md
  // 결정: workspace/decisions/2026-06-14-unify-agent-sessions.md
  const effectiveCanDelete = canDelete && !isChannelAi && (!session.archived || deleteActionIcon === "down");
  const isMobile = useSessionStore((s) => s.isMobile);
  const ownerUsername = session.projectId && session.ownerUsername
    ? session.ownerUsername
    : null;
  const ownerLabel = ownerUsername
    ? ownerUsername.split("@")[0]
    : null;
  const agentFirstEnabled = useSettingsStore(
    (s) => s.serverConfig?.agentFirstEnabled === true,
  );
  const sessionProject = useMemo(
    () =>
      session.projectId
        ? projects?.find((project) => project.id === session.projectId) || null
        : null,
    [projects, session.projectId],
  );
  const [elapsedNow, setElapsedNow] = useState(() => serverNowMs());

  useEffect(() => {
    if (rowState.elapsed === "none" || !turnState?.startedAt) return;
    setElapsedNow(serverNowMs());
    const timer = window.setInterval(() => setElapsedNow(serverNowMs()), 1000);
    return () => window.clearInterval(timer);
  }, [rowState.elapsed, turnState?.startedAt]);

  const turnElapsed =
    rowState.elapsed !== "none" && turnState?.startedAt
      ? elapsedTime(elapsedNow - turnState.startedAt)
      : null;
  const runningElapsed = rowState.elapsed === "running" ? turnElapsed : null;
  const runningActivity =
    rowState.indicator.kind === "running"
      ? rowState.indicator.summary || t("writingResponse")
      : null;
  const longContext = isLongContextSessionModel(session.modelUsed);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const startEditing = () => {
    setEditName(session.name);
    setEditing(true);
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    startEditing();
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, presentation: "pointer" });
  };

  const openContextFromButton = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setCtxMenu({
      x: rect.right,
      y: rect.bottom,
      presentation: isMobile ? "sheet" : "pointer",
    });
  };

  const commitRename = () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== session.name) {
      onRename(session.id, trimmed);
    }
    setEditing(false);
  };

  return (
    <>
      <div
        data-sidebar-session-id={session.id}
        className={`sidebar-session-row ${recentInbox ? "sidebar-session-row--recent" : ""} group flex items-center gap-1 rounded-md px-2 cursor-pointer text-sidebar-session-size transition-colors duration-150 ${isMobile ? "min-h-[28px] py-0" : isTouchDevice.current ? "min-h-[44px] py-1" : "py-1.5 lg:py-0.5"} ${
          isActive
            ? isMobile
              ? "is-active bg-primary-500/10 text-gray-100 ring-1 ring-primary-500/25"
              : "is-active bg-surface-800/75 text-gray-100 ring-1 ring-surface-700/35"
            : isMobile
              ? "text-gray-400 hover:bg-primary-500/10 hover:text-gray-200"
              : "text-gray-400 hover:bg-surface-850/75 hover:text-gray-200"
        }`}
        // HTML5 drag-and-drop은 모바일(iOS/Android)에서 동작하지 않으면서도,
        // draggable 속성이 남아 있으면 브라우저가 세로 스크롤과 드래그 후보를 동시에 판정해
        // 프레임이 튀는(jitter) 원인이 된다. 터치 기기에서는 draggable을 끄고
        // touch-action: pan-y로 세로 스크롤을 명시적으로 우선시킨다.
        draggable={!isTouchDevice.current}
        style={isTouchDevice.current ? { touchAction: "pan-y" } : undefined}
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", session.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onClick={(e) => {
          markTurnRead(session.id);
          // v3 (path B): shift/cmd/ctrl-click opens the session in a NEW chat tab
          // (keeps the current one). openChatTab(forceNew) runs *before* onSelect
          // so handleSelectSession's idempotent openChatTab finds it already open.
          // See: workspace/decisions/2026-05-22-global-multi-tab-shell.md (v3)
          if (e.shiftKey || e.metaKey || e.ctrlKey) {
            useFileStore.getState().openChatTab(session.id, { forceNew: true });
          }
          onSelect(session);
        }}
        onAuxClick={(e) => {
          // Middle-click → open in a new chat tab (browser convention).
          if (e.button === 1) {
            e.preventDefault();
            markTurnRead(session.id);
            useFileStore.getState().openChatTab(session.id, { forceNew: true });
            onSelect(session);
          }
        }}
        onMouseEnter={() => {
          if (!isTouchDevice.current) {
            setIsHovered(true);
            if (!isActive) prefetchSessionMessages(session.id);
          }
        }}
        onMouseLeave={() => {
          if (!isTouchDevice.current) setIsHovered(false);
        }}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
      >
        <div className="sidebar-session-highlight flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-0.5">
        {agentFirstEnabled && showAgentAvatar && sessionProject && !editing && (
          <AgentIdentityAvatar
            project={sessionProject}
            variant="list"
            showListAccent={false}
            className="mr-1 h-5 w-5 shrink-0 rounded-md"
            fallbackClassName="mr-1 grid h-5 w-5 shrink-0 place-items-center rounded-md bg-surface-800 text-[10px]"
          />
        )}

        {/* Pinned session marker — quiet pin, always visible when pinned */}
        {session.favorite && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite(session.id, false);
            }}
            className={`shrink-0 ${isMobile ? "text-primary-500/80 hover:text-primary-600" : "text-surface-500 hover:text-surface-300"} transition-colors ${isTouchDevice.current ? `grid ${isMobile ? "h-5 w-5" : "h-8 w-8"} place-items-center rounded-md` : ""}`}
            title={t("removeFavorite")}
          >
            <svg
              className="w-3 h-3"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M16 3.5v5.1l2.3 2.3c.45.45.13 1.2-.5 1.2h-4.55v7.15a.75.75 0 01-1.5 0V12.1H7.2c-.63 0-.95-.75-.5-1.2L9 8.6V3.5H7.75a.75.75 0 010-1.5h8.5a.75.75 0 010 1.5H16z" />
            </svg>
          </button>
        )}

        {!editing &&
          (rowState.indicator.kind === "awaiting_user" ? (
            <AwaitingUserMark />
          ) : rowState.indicator.kind === "running" ? (
            <RunIndicator
              size="xs"
              label=""
              className="tone-success tone-text shrink-0"
            />
          ) : rowState.indicator.kind === "error" ? (
            <span
              className="inline-flex h-4 w-3 shrink-0 items-center justify-center text-[13px] font-bold leading-none text-red-400"
              aria-label={t('errorOccurred')}
              title={t('errorClearsOnOpen')}
            >
              !
            </span>
          ) : rowState.indicator.kind === "stopped" ? (
            <span
              className="inline-flex h-4 w-3 shrink-0 items-center justify-center text-[12px] font-bold leading-none text-orange-300"
              aria-label={t('stopped')}
              title={t('stoppedClearsOnOpen')}
            >
              ■
            </span>
          ) : rowState.indicator.kind === "done" ? (
            <span
              className="tone-success tone-text inline-flex h-4 w-3 shrink-0 items-center justify-center text-[14px] font-bold leading-none opacity-90"
              aria-label={t('completed')}
              title={t('completedClearsOnOpen')}
            >
              ✓
            </span>
          ) : null)}

        {/* Name */}
        {editing ? (
          <input
            ref={inputRef}
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setEditing(false);
            }}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 min-w-0 h-[20px] lg:h-[18px] bg-surface-700 text-gray-100 text-sidebar-session-size px-1.5 py-0 rounded border border-surface-600 outline-none focus:border-primary-500"
          />
        ) : (
          <FadeOverflowText
            className={`flex-auto min-w-0 overflow-hidden whitespace-nowrap ${isMobile ? "leading-[16px]" : "leading-[20px] lg:leading-[18px]"} ${rowState.bold ? "font-bold text-gray-100" : "font-medium"}`}
            title={session.name}
          >
            {/* Private lock icon (prefix) — only shown for private sessions in a project */}
            {session.projectId && session.visibility === "private" && (
              <svg
                className="inline-block w-3 h-3 mr-1 text-surface-600 align-middle"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                />
              </svg>
            )}
            <AgentSessionBadge session={session} />
            {isKanbanTask && (
              <span className="tone-pill tone-warning mr-1 text-[10px] font-bold px-1 rounded align-middle">
                run
              </span>
            )}
            {isDeploymentSession && (
              <span className="mr-1 text-[10px] font-semibold text-primary-700 dark:text-primary-200">
                (ext)
              </span>
            )}
            {isKanbanTask
              ? session.name.replace(/^\[task\]\s*/, "").replace(/^🟢\s*/, "")
              : session.name}
            {longContext ? (
              <span
                className="ml-1 text-[9px] font-bold text-amber-200 bg-amber-500/15 ring-1 ring-amber-400/25 px-1 rounded align-middle"
                title={t('longContextRouteHint')}
              >
                LONG
              </span>
            ) : null}
            {(session as any).engine === "local" && (
              <span className="tone-pill tone-success ml-1 text-[10px] font-bold px-1 rounded align-middle">
                LOCAL
              </span>
            )}
            {isChannelAi && (
              <span
                className="ml-1 text-[9px] font-bold text-cyan-200 bg-cyan-500/20 ring-1 ring-cyan-400/30 px-1 rounded align-middle"
                title={t('channelConversationHint')}
              >
                🤖 {t('channel')}
              </span>
            )}
            {isProactive && (
              <span className="ml-1 text-[10px] font-bold text-blue-300 bg-blue-500/15 px-1 rounded align-middle">
                💬 ai
              </span>
            )}
            {session.roomId && !isChannelAi && (
              <span className="ml-1 text-[9px] text-surface-600 align-middle">
                #thread
              </span>
            )}
          </FadeOverflowText>
        )}

        {session.archived && (
          <span className="shrink-0 rounded bg-surface-800 px-1 py-px text-[10px] text-surface-500">
            {t('sessionArchivedBadge')}
          </span>
        )}
        </div>

        {/* Time (default) → action buttons (on hover) — both always rendered,
            toggle via opacity only to prevent layout shift / jitter.
            Uses JS isHovered (not CSS group-hover) for touch/remote-desktop compat. */}
        {!editing && (
          <div className="relative ml-auto flex h-full flex-none min-w-fit max-w-[48%] items-center justify-end overflow-visible text-right">
            <span
              className={`sidebar-session-meta ${compactMetaAtNarrowWidth ? "sidebar-session-meta--compact-responsive" : ""} ${isMobile ? "sidebar-session-meta--mobile-visible text-gray-500" : "text-surface-700"} text-sidebar-session-meta-size flex items-center justify-end gap-1 whitespace-nowrap transition-opacity duration-150 ${isHovered ? "opacity-0" : "opacity-100"}`}
            >
              {rowState.indicator.kind === "awaiting_user" ? (
                <span className="tone-pill tone-warning text-[11px] font-semibold rounded px-1 py-0.5 leading-none">
                  {t('answerNeeded')}{turnElapsed ? ` · ${turnElapsed}` : ""}
                </span>
              ) : rowState.indicator.kind === "queued" ? (
                <span className="text-[11px] font-semibold text-primary-300 bg-primary-500/10 border border-primary-500/20 rounded px-1 py-0.5 leading-none">
                  Q{rowState.indicator.count}
                </span>
              ) : null}
              {runningElapsed ? (
                <span
                  className="shrink-0 whitespace-nowrap tabular-nums"
                  title={t('runningElapsedHint', { activity: runningActivity || t('running'), elapsed: runningElapsed })}
                >
                  {runningElapsed}
                </span>
              ) : isMobile ? (
                <span className="flex min-w-0 shrink items-center justify-end gap-1 tabular-nums" title={ownerLabel ? `${ownerUsername} · ${relativeTime(session.updatedAt)}` : relativeTime(session.updatedAt)}>
                  {ownerLabel ? <span className="max-w-[9ch] truncate font-normal">{ownerLabel}</span> : null}
                  {ownerLabel ? <span aria-hidden="true">·</span> : null}
                  <span className="shrink-0">{relativeTime(session.updatedAt)}</span>
                </span>
              ) : recentInbox ? (
                <span className="tabular-nums" title={t('recentActivity')}>
                  {relativeTime(session.updatedAt)}
                </span>
              ) : ownerUsername && ownerLabel ? (
                <>
                  <span
                    className="shrink min-w-[2ch] max-w-[9ch] truncate font-normal text-surface-500"
                    title={t('sessionAuthor', { name: ownerUsername })}
                  >
                    {ownerLabel}
                  </span>
                  <span
                    className="shrink-0 whitespace-nowrap"
                    title={t('recentActivity')}
                  >
                    {" "}
                    · {relativeTime(session.updatedAt)}
                  </span>
                </>
              ) : (
                <span title={t('recentActivity')}>{relativeTime(session.updatedAt)}</span>
              )}
            </span>
            {isTouchDevice.current ? (
              <button
                onClick={openContextFromButton}
                className={`ml-0.5 grid ${isMobile ? "h-6 w-6 text-gray-500 active:bg-primary-500/10 active:text-primary-600" : "h-10 w-10 text-surface-500 active:bg-surface-750 active:text-surface-100"} place-items-center rounded-md`}
                title={t("sessionActions")}
                aria-label={t("sessionActions")}
              >
                <svg
                  className="w-4 h-4"
                  fill="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <circle cx="5" cy="12" r="1.8" />
                  <circle cx="12" cy="12" r="1.8" />
                  <circle cx="19" cy="12" r="1.8" />
                </svg>
              </button>
            ) : (
              <div
                className={`absolute right-0 top-1/2 -translate-y-1/2 flex items-center gap-0.5 transition-opacity duration-150 ${isHovered ? "opacity-100" : "opacity-0 pointer-events-none"}`}
              >
                {effectiveCanDelete && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(session.id);
                    }}
                    className="group/session-action relative p-1.5 lg:p-1 hover:text-surface-300 hover:bg-surface-700/50 rounded transition-all text-surface-700"
                    title={deleteActionIcon === "down" ? undefined : (deleteActionLabel ?? t("deleteSession"))}
                    aria-label={deleteActionLabel ?? t("deleteSession")}
                    aria-describedby={deleteActionIcon === "down" ? `hide-from-latest-hint-${session.id}` : undefined}
                  >
                    {deleteActionIcon === "down" ? (
                      <>
                        <svg
                          className="w-3 h-3"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 9l-7 7-7-7"
                          />
                        </svg>
                        <span
                          id={`hide-from-latest-hint-${session.id}`}
                          role="tooltip"
                          className="pointer-events-none absolute bottom-full right-0 z-50 mb-1.5 hidden w-64 rounded-md border border-surface-700 bg-surface-900 px-2.5 py-2 text-left text-[11px] font-normal leading-4 text-surface-300 shadow-xl group-hover/session-action:block group-focus-visible/session-action:block"
                        >
                          {t("hideFromLatestHint")}
                        </span>
                      </>
                    ) : (
                      <svg
                        className="w-3 h-3"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d={deleteActionIcon === "archive"
                    ? "M3 3h18v5H3zM5 8v13h14V8M9 12h6"
                    : "M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6"}
                        />
                      </svg>
                    )}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Context menu is portaled to document.body so fixed coordinates stay viewport-relative. */}
      {ctxMenu && (
        <SessionContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          session={session}
          onRename={startEditing}
          onToggleFavorite={() =>
            onToggleFavorite(session.id, !session.favorite)
          }
          onDelete={() => onDelete(session.id)}
          onClose={() => setCtxMenu(null)}
          canDelete={effectiveCanDelete}
          canManageVisibility={session.ownerUsername === currentUsername}
          onShowRelated={() =>
            setRelatedPopover({ x: ctxMenu.x, y: ctxMenu.y })
          }
          onSelect={onSelect}
          mobile={ctxMenu.presentation === "sheet"}
          deleteActionLabel={deleteActionLabel}
          deleteActionIcon={deleteActionIcon}
        />
      )}
      {/* Related-sessions popover (Level 1 backlinks) */}
      {relatedPopover && (
        <RelatedSessionsPopover
          sessionId={session.id}
          x={relatedPopover.x}
          y={relatedPopover.y}
          onClose={() => setRelatedPopover(null)}
        />
      )}
    </>
  );
}

/* ── Deck assignment submenu ── */
function SessionDeckSubmenu({ x, y, session, onClose, onComplete }: { x: number; y: number; session: SessionMeta; onClose: () => void; onComplete: () => void }) {
  const { t } = useTranslation("layout");
  const ref = useRef<HTMLDivElement>(null);
  const sessions = useSessionStore((state) => state.sessions);
  const projectSessionsLoading = useSessionStore((state) => session.projectId ? state.projectSessionsLoading.has(session.projectId) : false);
  const [query, setQuery] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [showNewInput, setShowNewInput] = useState(false);
  const labels = useMemo(() => [...new Set(sessions.filter((candidate) => candidate.projectId === session.projectId && candidate.label).map((candidate) => candidate.label!))].sort(), [session.projectId, sessions]);
  useEffect(() => {
    if (session.projectId) void useSessionStore.getState().hydrateProjectSessions(session.projectId, { force: true });
  }, [session.projectId]);
  const filteredLabels = labels.filter((label) => label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const left = Math.min(Math.max(8, x), window.innerWidth - 268);
  const top = Math.min(Math.max(8, y), Math.max(8, window.innerHeight - 360));
  useEffect(() => {
    const close = (event: MouseEvent | TouchEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) onClose(); };
    document.addEventListener("mousedown", close); document.addEventListener("touchstart", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("touchstart", close); };
  }, [onClose]);
  const applyLabel = async (label: string | null) => {
    const previousLabel = session.label ?? null;
    useSessionStore.getState().updateSessionMeta(session.id, { label }); onComplete();
    const token = localStorage.getItem("token");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      const response = await fetch(`/api/sessions/${session.id}`, { method: "PATCH", headers, body: JSON.stringify({ label }) });
      if (!response.ok) throw new Error("deck assignment failed");
    } catch {
      useSessionStore.getState().updateSessionMeta(session.id, { label: previousLabel }); toastError(t("deckAssignmentFailed"));
    }
  };
  const itemClass = "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-gray-300 transition-colors hover:bg-primary-600/30 hover:text-white";
  return createPortal(<div ref={ref} role="menu" className="fixed z-[10000] w-[260px] overflow-hidden rounded-lg border border-surface-700 bg-surface-800 py-1 shadow-xl" style={{ left, top }} onClick={(event) => event.stopPropagation()}>
    <div className="px-2 pb-1 pt-1"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("searchDecks")} className="w-full rounded border border-surface-700 bg-surface-900 px-2 py-1.5 text-[12px] text-surface-200 outline-none placeholder:text-surface-600 focus:border-primary-500/50" autoFocus /></div>
    <button className={`${itemClass} ${!session.label ? "!text-primary-400" : ""}`} onClick={() => void applyLabel(null)}><span className="h-2 w-2 rounded-full bg-surface-500" /><span className="flex-1">{t("defaultDeck")}</span>{!session.label && <span className="text-primary-400">✓</span>}</button>
    <div className="max-h-[220px] overflow-y-auto overscroll-contain border-y border-surface-700/50 py-0.5">{projectSessionsLoading && <div className="px-3 py-2 text-[12px] text-surface-500">{t("loadingDecks")}</div>}{filteredLabels.map((label) => <button key={label} className={`${itemClass} ${session.label === label ? "!text-primary-400" : ""}`} onClick={() => void applyLabel(label)}><span className="h-2 w-2 rounded-full bg-primary-500/60" /><span className="min-w-0 flex-1 truncate">{label}</span>{session.label === label && <span className="text-primary-400">✓</span>}</button>)}{!projectSessionsLoading && filteredLabels.length === 0 && <div className="px-3 py-3 text-center text-[12px] text-surface-600">{t("noDeckResults")}</div>}</div>
    {showNewInput ? <div className="flex gap-1.5 px-2 py-1.5"><input value={newLabel} onChange={(event) => setNewLabel(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && newLabel.trim()) void applyLabel(newLabel.trim()); if (event.key === "Escape") setShowNewInput(false); }} placeholder={t("newDeckPlaceholder")} className="min-w-0 flex-1 rounded border border-surface-700 bg-surface-900 px-2 py-1 text-[12px] text-surface-200 outline-none" autoFocus /><button disabled={!newLabel.trim()} onClick={() => void applyLabel(newLabel.trim())} className="text-[12px] font-semibold text-primary-400 disabled:opacity-40">{t("addDeck")}</button></div> : <button className={`${itemClass} !text-surface-500`} onClick={() => setShowNewInput(true)}><span className="text-base">＋</span>{t("newDeckMore")}</button>}
  </div>, document.body);
}
