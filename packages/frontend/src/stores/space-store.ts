import { create } from 'zustand';
import type { Space } from '@tower/shared';

interface SpaceStore {
  spaces: Space[];
  activeSpaceId: number | null;    // null = 전체 보기
  setSpaces: (spaces: Space[]) => void;
  setActiveSpace: (id: number | null) => void;
  addSpace: (space: Space) => void;
  updateSpace: (id: number, updates: Partial<Space>) => void;
  removeSpace: (id: number) => void;
}

// Persist last selected space in localStorage
function loadActiveSpace(): number | null {
  try {
    const raw = localStorage.getItem('activeSpaceId');
    if (raw !== null) return JSON.parse(raw);
  } catch {}
  return null;
}

function saveActiveSpace(id: number | null) {
  localStorage.setItem('activeSpaceId', JSON.stringify(id));
}

export const useSpaceStore = create<SpaceStore>((set) => ({
  spaces: [],
  activeSpaceId: loadActiveSpace(),
  setSpaces: (spaces) => set({ spaces }),
  setActiveSpace: (id) => {
    saveActiveSpace(id);
    set({ activeSpaceId: id });
  },
  addSpace: (space) => set((s) => ({ spaces: [...s.spaces, space] })),
  updateSpace: (id, updates) => set((s) => ({
    spaces: s.spaces.map((sp) => sp.id === id ? { ...sp, ...updates } : sp)
  })),
  removeSpace: (id) => set((s) => ({
    spaces: s.spaces.filter((sp) => sp.id !== id),
    activeSpaceId: s.activeSpaceId === id ? null : s.activeSpaceId
  })),
}));
