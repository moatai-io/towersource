// Owns: lightweight Approval Card inbox projection and notification count.
// Public API: useApprovalStore, refreshPendingApprovals, notifyApprovalCardsChanged.

import { create } from 'zustand';

export const APPROVAL_CARDS_CHANGED_EVENT = 'tower-approval-cards-changed';

interface ApprovalState {
  pendingAssignedCount: number;
  loading: boolean;
  lastLoadedAt: number | null;
  setPendingAssignedCount: (count: number) => void;
  setLoading: (loading: boolean) => void;
}

export const useApprovalStore = create<ApprovalState>((set) => ({
  pendingAssignedCount: 0,
  loading: false,
  lastLoadedAt: null,
  setPendingAssignedCount: (count) => set({ pendingAssignedCount: Math.max(0, count), lastLoadedAt: Date.now() }),
  setLoading: (loading) => set({ loading }),
}));

function approvalHeaders(): HeadersInit {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Refresh the assigned pending count without exposing card content globally. */
export async function refreshPendingApprovals(): Promise<number> {
  if (!localStorage.getItem('token')) {
    useApprovalStore.getState().setPendingAssignedCount(0);
    return 0;
  }
  useApprovalStore.getState().setLoading(true);
  try {
    const res = await fetch('/api/approval-cards?box=assigned&status=pending&limit=100', { headers: approvalHeaders() });
    if (!res.ok) return useApprovalStore.getState().pendingAssignedCount;
    const data = await res.json();
    const count = Array.isArray(data.cards) ? data.cards.length : 0;
    useApprovalStore.getState().setPendingAssignedCount(count);
    return count;
  } catch {
    return useApprovalStore.getState().pendingAssignedCount;
  } finally {
    useApprovalStore.getState().setLoading(false);
  }
}

/** Tell app-shell projections that card state changed after a local mutation. */
export function notifyApprovalCardsChanged(): void {
  window.dispatchEvent(new CustomEvent(APPROVAL_CARDS_CHANGED_EVENT));
}
