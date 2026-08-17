import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useGitStore, type GitCommitInfo } from '../../stores/git-store';
import { toastSuccess, toastError } from '../../utils/toast';

const API_BASE = '/api';

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = localStorage.getItem('token');
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = Math.floor((now - then) / 1000);

  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hr ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)} d ago`;
  return new Date(dateStr).toLocaleDateString('en-US');
}

function CommitBadge({ type }: { type: string }) {
  if (type === 'auto') {
    return <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-surface-700/50 text-gray-500 font-medium">auto</span>;
  }
  if (type === 'manual') {
    return <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-blue-500/20 text-blue-400 font-medium">manual</span>;
  }
  if (type === 'rollback') {
    return <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-400 font-medium">rollback</span>;
  }
  return null;
}

function CommitItem({
  commit,
  isExpanded,
  onToggle,
  onRollback,
  onViewDiff,
}: {
  commit: GitCommitInfo;
  isExpanded: boolean;
  onToggle: () => void;
  onRollback: (hash: string) => void;
  onViewDiff: (hash: string) => void;
}) {
  return (
    <div className="border-b border-surface-800/50 last:border-b-0">
      <button
        onClick={onToggle}
        className="w-full text-left px-3 py-2.5 hover:bg-surface-800/50 transition-colors"
      >
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[13px] font-mono text-primary-400">{commit.shortHash}</span>
          <span className="text-[13px] text-gray-300 font-medium truncate">{commit.authorName}</span>
          <span className="text-[12px] text-surface-600 ml-auto shrink-0">{timeAgo(commit.createdAt)}</span>
        </div>
        <div className="flex items-center gap-2">
          <CommitBadge type={commit.commitType} />
          <span className="text-[13px] text-gray-400 truncate">{commit.message}</span>
        </div>
        {commit.filesChanged.length > 0 && (
          <div className="flex items-center gap-1 mt-1">
            <svg className="w-3 h-3 text-surface-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={isExpanded ? "M19 9l-7 7-7-7" : "M9 5l7 7-7 7"} />
            </svg>
            <span className="text-[12px] text-surface-600">{commit.filesChanged.length} files</span>
          </div>
        )}
      </button>

      {isExpanded && (
        <div className="px-3 pb-3 space-y-2">
          {/* Changed files */}
          {commit.filesChanged.length > 0 && (
            <div className="bg-surface-800/50 rounded-md p-2 space-y-0.5">
              {commit.filesChanged.map((file) => (
                <div key={file} className="text-[12px] text-gray-400 font-mono truncate">
                  {file}
                </div>
              ))}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-2">
            <button
              onClick={() => onViewDiff(commit.hash)}
              className="flex-1 text-[12px] py-1.5 px-2 rounded bg-surface-800 hover:bg-surface-700 text-gray-400 hover:text-gray-300 transition-colors font-medium"
            >
              View Diff
            </button>
            <button
              onClick={() => onRollback(commit.hash)}
              className="flex-1 text-[12px] py-1.5 px-2 rounded bg-red-500/10 hover:bg-red-500/20 text-red-400 hover:text-red-300 transition-colors font-medium"
            >
              Rollback
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

interface GitPanelProps {
  onViewDiff?: (diff: string) => void;
}

export function GitPanel({ onViewDiff }: GitPanelProps) {
  const { t } = useTranslation('git');
  const commits = useGitStore((s) => s.commits);
  const isLoading = useGitStore((s) => s.isLoading);
  const expandedCommit = useGitStore((s) => s.expandedCommit);
  const setExpandedCommit = useGitStore((s) => s.setExpandedCommit);

  const [commitMessage, setCommitMessage] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [confirmRollback, setConfirmRollback] = useState<string | null>(null);

  const handleManualCommit = useCallback(async () => {
    if (!commitMessage.trim()) return;
    setIsSaving(true);
    try {
      const res = await fetch(`${API_BASE}/git/commit`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ message: commitMessage.trim() }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error);
      }
      const commit = await res.json();
      useGitStore.getState().addCommit(commit);
      setCommitMessage('');
      toastSuccess('Snapshot saved');
    } catch (err: any) {
      toastError(err.message || 'Commit failed');
    } finally {
      setIsSaving(false);
    }
  }, [commitMessage]);

  const handleRollback = useCallback(async (hash: string) => {
    try {
      const res = await fetch(`${API_BASE}/git/rollback`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ hash }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error);
      }
      const commit = await res.json();
      useGitStore.getState().addCommit(commit);
      setConfirmRollback(null);
      toastSuccess('Rollback complete');
    } catch (err: any) {
      toastError(err.message || 'Rollback failed');
    }
  }, []);

  const handleViewDiff = useCallback(async (hash: string) => {
    try {
      const headers = getAuthHeaders();
      const res = await fetch(`${API_BASE}/git/diff/${hash}`, { headers });
      if (!res.ok) throw new Error('Failed to load diff');
      const data = await res.json();
      onViewDiff?.(data.diff || '(No changes)');
    } catch (err: any) {
      toastError(err.message);
    }
  }, [onViewDiff]);

  const handleLoadMore = useCallback(async () => {
    const store = useGitStore.getState();
    store.setLoading(true);
    try {
      const headers = getAuthHeaders();
      const res = await fetch(
        `${API_BASE}/git/log?limit=50&offset=${store.commits.length}`,
        { headers }
      );
      if (res.ok) {
        const more = await res.json();
        store.appendCommits(more);
      }
    } catch {} finally {
      store.setLoading(false);
    }
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* Manual commit form */}
      <div className="p-3 border-b border-surface-800/50">
        <div className="flex gap-2">
          <input
            type="text"
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleManualCommit(); } }}
            placeholder={t('snapshotMessagePlaceholder')}
            className="flex-1 bg-surface-800 border border-surface-700 rounded-md text-[14px] text-gray-300 px-3 py-1.5 placeholder-surface-600 outline-none focus:border-primary-500/50 transition-colors"
          />
          <button
            onClick={handleManualCommit}
            disabled={!commitMessage.trim() || isSaving}
            className="px-3 py-1.5 text-[13px] font-semibold rounded-md bg-primary-600 hover:bg-primary-500 disabled:bg-surface-700 disabled:text-surface-600 text-white transition-colors shrink-0"
          >
            {isSaving ? '...' : 'Save'}
          </button>
        </div>
      </div>

      {/* Commit list */}
      <div className="flex-1 overflow-y-auto">
        {isLoading && commits.length === 0 ? (
          <p className="text-[14px] text-surface-600 text-center py-8">Loading...</p>
        ) : commits.length === 0 ? (
          <p className="text-[14px] text-surface-600 text-center py-8">No snapshots yet</p>
        ) : (
          <>
            {commits.map((commit) => (
              <CommitItem
                key={commit.hash}
                commit={commit}
                isExpanded={expandedCommit === commit.hash}
                onToggle={() => setExpandedCommit(commit.hash)}
                onRollback={(hash) => setConfirmRollback(hash)}
                onViewDiff={handleViewDiff}
              />
            ))}
            {commits.length >= 50 && (
              <button
                onClick={handleLoadMore}
                disabled={isLoading}
                className="w-full py-3 text-[13px] text-surface-600 hover:text-surface-400 transition-colors"
              >
                {isLoading ? 'Loading...' : 'Load more...'}
              </button>
            )}
          </>
        )}
      </div>

      {/* Rollback confirmation dialog */}
      {confirmRollback && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-surface-900 border border-surface-700 rounded-xl p-5 max-w-sm w-full mx-4 shadow-2xl">
            <h3 className="text-[16px] font-semibold text-gray-200 mb-2">Confirm Rollback</h3>
            <p className="text-[14px] text-gray-400 mb-4">
              Roll back files to this point?<br />
              <span className="font-mono text-primary-400">{confirmRollback.slice(0, 7)}</span>
              <br />
              <span className="text-[13px] text-surface-600">Current changes will be saved as a new rollback commit.</span>
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmRollback(null)}
                className="px-4 py-1.5 text-[14px] rounded-md bg-surface-800 hover:bg-surface-700 text-gray-400 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleRollback(confirmRollback)}
                className="px-4 py-1.5 text-[14px] rounded-md bg-red-600 hover:bg-red-500 text-white font-semibold transition-colors"
              >
                Rollback
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
