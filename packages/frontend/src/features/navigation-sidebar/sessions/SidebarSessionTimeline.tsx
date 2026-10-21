// Owns: Sidebar 최근 Session timeline의 날짜 header와 Project run 표현. Public API: SidebarSessionTimeline. See ../README.md.
import React from 'react';
import type { SessionMeta } from '../../../stores/session-store';
import type { Project } from '../../../stores/project-store';
import { SessionItem } from '../../../components/sessions/SessionItem';
import type { SidebarSessionTimelineRun } from './sidebar-session-timeline-model';

interface SidebarSessionTimelineProps {
  runs: SidebarSessionTimelineRun[];
  activeSessionId: string | null;
  currentUsername?: string;
  projects: Project[];
  hideFromLatestLabel: string;
  onSelectSession: (session: SessionMeta) => void;
  onDismissSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, name: string) => void;
  onToggleFavorite: (sessionId: string, favorite: boolean) => void;
  onMoveSession: (sessionId: string, projectId: string | null) => void;
}

/** 계산된 timeline run을 상태 소유 없이 Sidebar markup으로 렌더링한다. */
export function SidebarSessionTimeline({
  runs,
  activeSessionId,
  currentUsername,
  projects,
  hideFromLatestLabel,
  onSelectSession,
  onDismissSession,
  onRenameSession,
  onToggleFavorite,
  onMoveSession,
}: SidebarSessionTimelineProps) {
  return runs.map((run, runIndex) => (
    <React.Fragment key={`${run.dateKey}:${run.key}:${run.sessions[0].id}`}>
      {(runIndex === 0 || runs[runIndex - 1].dateKey !== run.dateKey) && (
        <div className="sidebar-timeline-date px-2 pb-1 pt-3 text-[11px] font-semibold text-surface-500" data-new-date-group={run.dateKey}>
          <span>{run.dateLabel}</span>
        </div>
      )}
      {run.project ? (
        <section className="min-w-0 pb-1" data-new-agent-run={run.project.id}>
          <div className="sidebar-timeline-project flex items-center px-2 pb-0.5 pt-1 text-[11px] font-semibold text-surface-500">
            <span className="min-w-0 flex-1 truncate">{run.project.agent?.displayName || run.project.name}</span>
          </div>
          <div className="sidebar-timeline-sessions ml-2.5 space-y-0.5 border-l border-surface-700/25 pl-3">
            {run.sessions.map((session) => (
              <SessionItem
                key={`active-${session.id}`}
                session={session}
                isActive={session.id === activeSessionId}
                currentUsername={currentUsername}
                onSelect={onSelectSession}
                onDelete={onDismissSession}
                onRename={onRenameSession}
                onToggleFavorite={onToggleFavorite}
                onMoveToProject={onMoveSession}
                projects={projects}
                deleteActionLabel={hideFromLatestLabel}
                deleteActionIcon="down"
                recentInbox
                compactMetaAtNarrowWidth
              />
            ))}
          </div>
        </section>
      ) : (
        <SessionItem
          session={run.sessions[0]}
          isActive={run.sessions[0].id === activeSessionId}
          currentUsername={currentUsername}
          onSelect={onSelectSession}
          onDelete={onDismissSession}
          onRename={onRenameSession}
          onToggleFavorite={onToggleFavorite}
          onMoveToProject={onMoveSession}
          projects={projects}
          deleteActionLabel={hideFromLatestLabel}
          deleteActionIcon="down"
          recentInbox
          compactMetaAtNarrowWidth
        />
      )}
    </React.Fragment>
  ));
}
