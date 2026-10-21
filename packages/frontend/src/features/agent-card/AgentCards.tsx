// Owns: React rendering for Agent activity and participant messages.
// Public API: AgentCard, AgentOriginBubble.
// See README.md and _DECISIONS.md.

import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { RunIndicator } from "../../components/common/RunIndicator";
import {
  AgentCharacterAvatar,
  agentFaceImageUrl,
  characterFace,
  distributedKoreanCharacterId,
} from "../agent-profile/characters";
import { useActiveSessionStreaming } from "../../hooks/useActiveSessionStreaming";
import {
  useChatStore,
  type ChatMessage,
  type ContentBlock,
} from "../../stores/chat-store";
import { useSessionStore } from "../../stores/session-store";
import {
  fileServeUrl,
  isPreviewableImageFilePath,
} from "../../utils/file-path-links";
import {
  getToolActivityLabel,
  getToolActivityNoun,
} from "../../utils/message-parser";
import {
  getAgentCardTitle,
  getAgentPromptPreview,
  parseAgentWorkerResult,
  type AgentWorkerResultMeta,
} from "./agent-card-model";

const agentCardUiState = {
  expanded: new Map<string, { expanded: boolean }>(),
};

const FILE_TAG_REGEX = /\[file:\s*([^\]]+)\]/g;

function renderAgentText(
  text: string,
  onFileClick?: (path: string) => void,
): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  const regex = new RegExp(FILE_TAG_REGEX.source, "g");

  for (const match of text.matchAll(regex)) {
    const fullMatch = match[0];
    const filePath = match[1].trim();
    const start = match.index!;

    if (start > lastIndex) {
      parts.push(
        <React.Fragment key={`t-${lastIndex}`}>
          {text.slice(lastIndex, start)}
        </React.Fragment>,
      );
    }

    const fileName = filePath.split("/").pop() || filePath;
    const displayName = fileName.replace(/^\d{10,}-/, "");

    if (isPreviewableImageFilePath(filePath)) {
      parts.push(
        <span key={`f-${start}`} className="block my-2">
          <img
            src={fileServeUrl(filePath)}
            alt={displayName}
            className="max-w-full max-h-[300px] rounded-lg border border-surface-700/40 cursor-pointer hover:border-primary-500/50 transition-colors"
            loading="lazy"
            onClick={() => onFileClick?.(filePath)}
          />
          <span className="text-[13px] text-gray-500 mt-1 block">
            {displayName}
          </span>
        </span>,
      );
    } else {
      parts.push(
        <span
          key={`f-${start}`}
          className="file-chip inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[14px] cursor-pointer transition-colors mx-0.5"
          onClick={() => onFileClick?.(filePath)}
        >
          📄 {displayName}
        </span>,
      );
    }

    lastIndex = start + fullMatch.length;
  }

  if (lastIndex < text.length) {
    parts.push(
      <React.Fragment key={`t-${lastIndex}`}>
        {text.slice(lastIndex)}
      </React.Fragment>,
    );
  }

  return parts.length > 0
    ? parts
    : [<React.Fragment key="raw">{text}</React.Fragment>];
}

function getMessageText(content: ContentBlock[]): string {
  return content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("\n");
}

function formatMessageTime(ts: number, t: (key: string, options?: Record<string, unknown>) => string): string {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();

  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (isToday) return time;
  if (isYesterday) return t("agentCard.yesterdayAt", { time });
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

function formatAgentCreatedAt(ts: number | undefined, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (!ts) return "now";
  const age = Date.now() - ts;
  if (age < 60_000) return "now";
  if (age < 60 * 60_000) return `${Math.max(1, Math.floor(age / 60_000))}m ago`;
  if (age < 24 * 60 * 60_000) return formatMessageTime(ts, t);
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function stripAgentPrefix(text: string, fallbackName?: string): string {
  const escapedName = fallbackName
    ? fallbackName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    : "[^)]+";
  return text
    .replace(new RegExp(`^_\\(${escapedName} 답\\)_:\\s*`), "")
    .replace(new RegExp(`^_\\(${escapedName} 에서\\)_:\\s*`), "");
}

function isBrowserNewTabClick(e: React.MouseEvent): boolean {
  return e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey;
}

function openAgentSession(e: React.MouseEvent, sessionId: string) {
  if (isBrowserNewTabClick(e)) return;
  e.preventDefault();
  e.stopPropagation();
  window.dispatchEvent(
    new CustomEvent("kanban-select-session", {
      detail: { sessionId, forceNew: e.shiftKey },
    }),
  );
}

function AgentSessionLink({
  sessionId,
  label,
  title,
}: {
  sessionId?: string;
  label?: string;
  title?: string;
}) {
  const { t } = useTranslation("chat");
  if (!sessionId) return null;
  const href = `/s/${sessionId}`;
  return (
    <a
      href={href}
      onClick={(e) => openAgentSession(e, sessionId)}
      className="inline-flex max-w-[260px] items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-medium text-surface-500 transition-colors hover:bg-white/5 hover:text-surface-300"
      title={title ?? t("agentCard.openSessionMain", { defaultValue: "작업 세션을 메인 탭에서 열기" })}
    >
      <span aria-hidden="true" className="text-surface-600">
        ↗
      </span>
      <span className="truncate">{label || t("agentCard.openSession")}</span>
    </a>
  );
}

// Only link sessions already visible to this viewer. A missing list entry is
// not proof of denial; keep the provenance label without fetching private metadata.
function AgentCommunicationRoute({
  fromId, fromName, toId, toName,
}: {
  fromId?: string; fromName?: string; toId?: string; toName?: string;
}) {
  const { t } = useTranslation("chat");
  const sessions = useSessionStore((s) => s.sessions);
  const endpoint = (id: string | undefined, fallback: string | undefined, role: "sender" | "recipient") => {
    const session = id ? sessions.find((s) => s.id === id || s.shortCode === id) : undefined;
    const name = session?.name || fallback || t(`agentCard.${role}`);
    const title = t(`agentCard.${role}Named`, { name });
    return session ? (
      <AgentSessionLink sessionId={session.id} label={name} title={title} />
    ) : (
      <span className="min-w-0 max-w-[260px] truncate px-1.5 py-0.5" title={title}>{name}</span>
    );
  };
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1 px-2 py-1 text-[12px] text-surface-500" aria-label={t("agentCard.communicationRoute")}>
      {endpoint(fromId, fromName, "sender")}
      <span aria-hidden="true">→</span>
      {endpoint(toId, toName, "recipient")}
    </div>
  );
}

function AgentIdentityMark({
  face,
  name,
  className = "h-7 w-7",
}: {
  face?: string;
  name: string;
  className?: string;
}) {
  const imageUrl = agentFaceImageUrl(face);
  const characterId = imageUrl ? characterFace(face) : null;
  if (characterId) {
    return (
      <AgentCharacterAvatar
        id={characterId}
        className={`${className} shrink-0 rounded-lg`}
        variant="list"
        title={name}
      />
    );
  }
  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt=""
        className={`${className} shrink-0 rounded-lg object-cover`}
        aria-hidden="true"
      />
    );
  }
  if (
    face &&
    !face.startsWith("character:") &&
    !face.startsWith("generated:")
  ) {
    return (
      <span
        className={`${className} flex shrink-0 items-center justify-center rounded-lg border border-surface-700/40 bg-surface-850 text-[17px]`}
        title={name}
      >
        {face}
      </span>
    );
  }
  return (
    <AgentCharacterAvatar
      id={distributedKoreanCharacterId(name || "Agent")}
      className={`${className} shrink-0 rounded-lg`}
      variant="list"
      title={name}
    />
  );
}

function AgentStatusMark({
  isRunning,
  reported,
}: {
  isRunning: boolean;
  reported: boolean;
}) {
  const { t } = useTranslation("chat");
  if (isRunning) {
    return (
      <RunIndicator size="sm" label={t("agentCard.working")} className="text-primary-300" />
    );
  }
  if (reported) {
    const label = t("agentCard.responseComplete");
    return (
      <span
        className="inline-flex h-5 w-5 items-center justify-center text-[17px] font-bold leading-none text-emerald-300/90"
        aria-label={label}
        title={label}
      >
        ✓
      </span>
    );
  }
  return (
    <span
      className="h-1.5 w-1.5 rounded-full bg-violet-300/70"
      aria-label={t("agentCard.ready")}
    />
  );
}

function useAgentToolStats(toolId: string) {
  const messages = useChatStore((s) => s.messages);
  return useMemo(() => {
    let toolCount = 0;
    let lastToolName = "";
    let lastToolSummary = "";
    const typeCounts: Record<string, number> = {};
    for (const msg of messages) {
      if (msg.parentToolUseId !== toolId) continue;
      for (const block of msg.content) {
        if (block.type === "tool_use" && block.toolUse) {
          toolCount++;
          const t = block.toolUse;
          lastToolName = t.name;
          const activityNoun = getToolActivityNoun(t.name, t.input || {});
          typeCounts[activityNoun] = (typeCounts[activityNoun] || 0) + 1;
          lastToolSummary = getToolActivityLabel(t.name, t.input || {});
        }
      }
    }
    const typeLabels = Object.entries(typeCounts).map(([name, count]) =>
      count > 1 ? `${name} ×${count}` : name,
    );
    return { toolCount, lastToolName, lastToolSummary, typeLabels };
  }, [messages, toolId]);
}

export function AgentOriginBubble({
  message,
  onFileClick,
}: {
  message: ChatMessage;
  onFileClick?: (path: string) => void;
}) {
  const { t } = useTranslation("chat");
  const metadata = (message.metadata as any) || {};
  const meta =
    metadata.agentWake || metadata.agentSend || metadata.agentReport || {};
  const structuredRunBlock = message.content.find(
    (b) => b.type === "agent_run",
  ) as any;
  const structuredRun = structuredRunBlock?.agentRun || structuredRunBlock;
  const agentName =
    structuredRun?.workerName ||
    meta.workerName ||
    meta.fromName ||
    message.username ||
    "Agent";
  const agentFace = structuredRun?.workerFace || meta.workerFace;
  const agentRole = structuredRun?.workerRole || meta.workerRole;
  const agentTagline = structuredRun?.workerTagline || meta.workerTagline;
  const agentIdentityLine = agentTagline || agentRole;
  const fallbackText = stripAgentPrefix(
    getMessageText(message.content)
      .replace(/<agent-report>[\s\S]*?<\/agent-report>/g, "")
      .trim(),
    meta.fromName || agentName,
  );
  const summary = structuredRun?.summary || fallbackText;
  const detailArtifactPaths = Array.isArray(structuredRun?.detailArtifactPaths)
    ? structuredRun.detailArtifactPaths.filter(
        (p: unknown): p is string =>
          typeof p === "string" && p.trim().length > 0,
      )
    : [];
  const detailArtifacts =
    structuredRun?.detailArtifacts || structuredRun?.detailArtifactSummary;
  const readIfNeeded = structuredRun?.readIfNeeded;
  const retrievalHint = structuredRun?.retrievalHint;
  const suggestedNext = structuredRun?.suggestedNext;
  const preview = summary.replace(/\s+/g, " ").trim();
  const answerCanExpand = preview.length > 180;
  const backingSessionId =
    structuredRun?.backingSessionId ||
    (typeof meta.backingSessionId === "string"
      ? meta.backingSessionId
      : undefined);
  const parentSessionId =
    structuredRun?.parentSessionId ||
    (typeof meta.parentSessionId === "string"
      ? meta.parentSessionId
      : undefined);
  const parentSessionName =
    structuredRun?.parentSessionName ||
    (typeof meta.parentSessionName === "string"
      ? meta.parentSessionName
      : undefined);
  const currentSessionId = useChatStore((s) => s.sessionId) || undefined;
  const isIncomingRequest = !!metadata.agentSend;
  const communicationRoute = (
    <AgentCommunicationRoute
      fromId={isIncomingRequest ? parentSessionId : backingSessionId}
      fromName={isIncomingRequest ? parentSessionName || meta.fromName : agentName}
      toId={currentSessionId}
    />
  );
  const cardKey = `agent-origin:${message.id}`;
  const [expanded, setExpanded] = useState(
    agentCardUiState.expanded.get(cardKey)?.expanded || false,
  );
  const toggleExpanded = () => {
    const next = !expanded;
    agentCardUiState.expanded.set(cardKey, { expanded: next });
    setExpanded(next);
  };

  return (
    <div
      id={message.shortId ? `m-${message.shortId}` : undefined}
      data-message-id={message.id}
      className="flex justify-start gap-3 py-4 group/message"
    >
      <AgentIdentityMark
        face={agentFace}
        name={agentName}
        className="h-8 w-8 mt-0.5"
      />
      <div className="min-w-0 w-full max-w-3xl">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[14px] font-semibold text-surface-100">
              {agentName}
            </span>

            {message.timestamp && (
              <span className="text-[12px] text-surface-500">
                {formatMessageTime(message.timestamp, t)}
              </span>
            )}
          </div>
          {agentIdentityLine && (
            <div className="mt-0.5 truncate text-[12px] text-surface-500">
              {agentIdentityLine}
            </div>
          )}
          {communicationRoute}
          {summary && !expanded && (
            <div className="mt-1 line-clamp-4 whitespace-pre-wrap text-msg-size leading-relaxed text-surface-200">
              {renderAgentText(summary, onFileClick)}
            </div>
          )}
        </div>
        {(answerCanExpand ||
          detailArtifacts ||
          detailArtifactPaths.length > 0 ||
          readIfNeeded ||
          retrievalHint ||
          suggestedNext ||
          backingSessionId) && (
          <button
            type="button"
            onClick={toggleExpanded}
            aria-expanded={expanded}
            className="mt-1 text-[12px] font-medium text-surface-500 hover:text-surface-300"
          >
            {expanded ? t("agentCard.collapseResponse") : t("agentCard.expandResponse")}
          </button>
        )}

        {expanded && (
          <div className="mt-3 border-l border-surface-700/40 pl-3">
            <div className="text-msg-size text-gray-200 leading-relaxed whitespace-pre-wrap">
              {renderAgentText(summary, onFileClick)}
            </div>
            {(detailArtifacts || detailArtifactPaths.length > 0) && (
              <div className="mt-4 border-t border-surface-700/30 pt-3">
                <div className="text-[12px] font-medium text-surface-500 mb-1">
                  {t("agentCard.relatedFiles")}
                </div>
                {detailArtifacts && (
                  <div className="text-[15px] text-surface-300 leading-relaxed whitespace-pre-wrap">
                    {renderAgentText(detailArtifacts, onFileClick)}
                  </div>
                )}
                {detailArtifactPaths.length > 0 && (
                  <div className="mt-2 space-y-1 text-[15px] text-surface-300 leading-relaxed">
                    {detailArtifactPaths.map((artifactPath: string) => (
                      <div key={artifactPath} className="font-mono break-all">
                        {renderAgentText(artifactPath, onFileClick)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {readIfNeeded && (
              <div className="mt-3 border-l border-surface-700/40 pl-3">
                <div className="text-[12px] font-medium text-surface-500 mb-1">
                  {t("agentCard.readIfNeeded")}
                </div>
                <div className="text-[15px] text-surface-300 leading-relaxed whitespace-pre-wrap">
                  {renderAgentText(readIfNeeded, onFileClick)}
                </div>
              </div>
            )}
            {retrievalHint && (
              <div className="mt-3 border-l border-surface-700/40 pl-3">
                <div className="text-[12px] font-medium text-surface-500 mb-1">
                  {t("agentCard.retrievalHint")}
                </div>
                <div className="text-[15px] text-surface-300 leading-relaxed whitespace-pre-wrap">
                  {retrievalHint}
                </div>
              </div>
            )}
            {suggestedNext && (
              <div className="mt-4 border-t border-surface-700/30 pt-3">
                <div className="text-[12px] font-medium text-surface-500 mb-1">
                  {t("agentCard.suggestedNext")}
                </div>
                <div className="text-[15px] text-surface-300 leading-relaxed whitespace-pre-wrap">
                  {suggestedNext}
                </div>
              </div>
            )}
            <div className="mt-3 flex items-center gap-2 flex-wrap text-[13px] text-surface-500">
              {parentSessionId && (
                <AgentSessionLink
                  sessionId={parentSessionId}
                  label={
                    parentSessionName
                      ? t("agentCard.parentNamed", { name: parentSessionName })
                      : t("agentCard.openParentSession")
                  }
                  title={t("agentCard.openParentSession", { defaultValue: "부모 세션 열기" })}
                />
              )}
              {backingSessionId && (
                <AgentSessionLink
                  sessionId={backingSessionId}
                  label={t("agentCard.openFullConversation")}
                  title={t("agentCard.openBackingSession", { defaultValue: "작업 세션 열기" })}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function AgentCard({
  block,
  messageTimestamp,
}: {
  block: ContentBlock;
  messageTimestamp?: number;
}) {
  const { t } = useTranslation("chat");
  const isStreaming = useActiveSessionStreaming();
  const toolId = block.toolUse?.id || "agent";
  const [expanded, setExpanded] = useState(
    agentCardUiState.expanded.get(toolId)?.expanded || false,
  );

  useEffect(() => {
    agentCardUiState.expanded.set(toolId, { expanded });
  }, [toolId, expanded]);

  const tool = block.toolUse!;
  const isRunning = !tool.result && isStreaming;
  const description = getAgentCardTitle(tool.name, tool.input);
  const promptPreview = getAgentPromptPreview(tool.name, tool.input);
  const resultMeta = parseAgentWorkerResult(tool.result, tool.input);
  const agentName = resultMeta?.name || description;
  const currentSessionId = useChatStore((s) => s.sessionId) || undefined;
  const targetSessionId = resultMeta?.backingSessionId ||
    (typeof tool.input.session_id === "string" ? tool.input.session_id : undefined);
  const communicationRoute = (
    <AgentCommunicationRoute fromId={currentSessionId} toId={targetSessionId} toName={agentName} />
  );
  const agentFace =
    resultMeta?.face ||
    (typeof tool.input.face === "string" ? tool.input.face : undefined);
  const agentIdentityLine =
    resultMeta?.tagline ||
    resultMeta?.role ||
    (typeof tool.input.tagline === "string"
      ? tool.input.tagline
      : typeof tool.input.role === "string"
        ? tool.input.role
        : "");
  const backingSessionRunning = useSessionStore((s) =>
    resultMeta?.backingSessionId
      ? s.streamingSessions.has(resultMeta.backingSessionId)
      : false,
  );
  const agentIsRunning = isRunning || backingSessionRunning;
  const hasLaunchResult = !!tool.result;
  const hasReported = hasLaunchResult && !agentIsRunning;
  const { toolCount, lastToolName, lastToolSummary, typeLabels } =
    useAgentToolStats(tool.id);
  const status = agentIsRunning
    ? {
        label: t("agentActivity.running"),
        title: t("agentCard.working"),
        border: "border-primary-400/35",
      }
    : hasReported
      ? {
          label: t("agentActivity.done"),
          title: t("agentCard.responseComplete"),
          border: "border-emerald-400/25",
        }
      : {
          label: t("agentActivity.deployed"),
          title: t("agentCard.ready"),
          border: "border-violet-400/25",
        };
  const runLabel = hasLaunchResult
    ? agentIsRunning
      ? t("agentActivity.running")
      : t("agentActivity.done")
    : t("agentActivity.queued");
  const missionMeta = [
    runLabel,
    t("agentActivity.created", {
      time: formatAgentCreatedAt(messageTimestamp, t),
    }),
  ]
    .filter(Boolean)
    .join(" · ");

  if (!expanded) {
    return (
      <div data-agent-text={description}>
        <button
          onClick={() => setExpanded(true)}
          aria-expanded="false"
          className={`group/agent-card inline-block max-w-2xl rounded-xl border ${status.border} bg-surface-900/45 px-3.5 py-3 text-left transition-colors hover:bg-surface-800/35`}
        >
          <div className="flex items-center gap-2.5">
            <AgentIdentityMark face={agentFace} name={agentName} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 min-w-0">
                <div className="truncate text-[15px] font-semibold text-surface-100">
                  {agentName}
                </div>
                <span className="shrink-0 text-[12px] font-medium text-surface-500">
                  {status.label}
                </span>
              </div>
              {agentIdentityLine && (
                <div className="mt-0.5 truncate text-[12px] text-surface-400">
                  {agentIdentityLine}
                </div>
              )}
              <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-surface-500">
                <span className="truncate">{missionMeta}</span>
                {toolCount > 0 && (
                  <>
                    <span className="text-surface-700">·</span>
                    <span className="tabular-nums">
                      {t("toolActivity.toolUseCount", { count: toolCount })}
                    </span>
                    <span className="truncate">
                      {agentIsRunning && lastToolName
                        ? lastToolSummary
                        : typeLabels.join(", ")}
                    </span>
                  </>
                )}
              </div>
              {promptPreview && (
                <div className="mt-2 line-clamp-3 whitespace-pre-wrap text-[13px] leading-relaxed text-surface-200">
                  {promptPreview}
                </div>
              )}
              {promptPreview.length > 180 && (
                <span className="mt-1 block text-[12px] font-medium text-surface-500 group-hover/agent-card:text-surface-300">
                  {t("agentCard.expandRequest")}
                </span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5 text-surface-500">
              <AgentStatusMark
                isRunning={agentIsRunning}
                reported={hasReported}
              />
              <svg
                className="h-3.5 w-3.5 text-surface-600 transition-transform group-hover/agent-card:translate-x-0.5 group-hover/agent-card:text-surface-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5l7 7-7 7"
                />
              </svg>
            </div>
          </div>
        </button>
        {communicationRoute}
      </div>
    );
  }

  return (
    <div
      className="inline-block max-w-2xl align-top"
      data-agent-text={description}
    >
      <div
        className={`overflow-hidden rounded-xl border ${status.border} bg-surface-900/45`}
      >
        <button
          onClick={() => setExpanded(false)}
          aria-expanded="true"
          className="group/agent-card flex w-full flex-col gap-1 px-3.5 py-3 text-left transition-colors hover:bg-surface-800/35"
        >
          <div className="flex items-center gap-2 w-full">
            <AgentIdentityMark face={agentFace} name={agentName} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 min-w-0">
                <div className="min-w-0 flex-1 truncate text-[15px] font-semibold text-surface-100">
                  {agentName}
                </div>
                <span className="shrink-0 text-[12px] font-medium text-surface-500">
                  {status.label}
                </span>
              </div>
              {agentIdentityLine && (
                <div className="mt-0.5 truncate text-[12px] text-surface-400">
                  {agentIdentityLine}
                </div>
              )}
              <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-surface-500">
                <span className="truncate">{missionMeta}</span>
                {toolCount > 0 && (
                  <span className="tabular-nums">
                    · {t("toolActivity.toolUseCount", { count: toolCount })}
                  </span>
                )}
              </div>
              {promptPreview && (
                <div className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-surface-200">
                  {promptPreview}
                </div>
              )}
            </div>
            <AgentStatusMark
              isRunning={agentIsRunning}
              reported={hasReported}
            />
            <svg
              className="h-3.5 w-3.5 shrink-0 rotate-90 text-surface-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 5l7 7-7 7"
              />
            </svg>
          </div>
          <span className="block pl-9 pt-1 text-[12px] font-medium text-surface-500 group-hover/agent-card:text-surface-300">
            {t("agentCard.collapseRequest")}
          </span>
          {toolCount > 0 && agentIsRunning && lastToolName && (
            <div className="flex items-center gap-1.5 pl-9 text-[12px] text-surface-400">
              <RunIndicator
                size="xs"
                label=""
                className="shrink-0 text-primary-400/70"
              />
              <span className="truncate">{lastToolSummary}</span>
            </div>
          )}
        </button>

        {communicationRoute}
        <div className="border-t border-surface-700/35 px-3.5 py-2.5 space-y-2">
          {agentIsRunning && (
            <div className="text-[13px] text-surface-500">
              {t("agentActivity.responsePending")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
