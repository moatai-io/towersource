import { create } from 'zustand';
export type { Pin } from '@tower/shared';
import type { Pin } from '@tower/shared';

interface PinState {
  pins: Pin[];
  setPins: (pins: Pin[]) => void;
  addPin: (pin: Pin) => void;
  removePin: (id: number) => void;
  updatePin: (id: number, updates: Partial<Pin>) => void;
  reorderPins: (orderedIds: number[]) => void;
}

export const usePinStore = create<PinState>((set) => ({
  pins: [],
  setPins: (pins) => set({ pins }),
  addPin: (pin) => set((s) => ({ pins: [...s.pins, pin] })),
  removePin: (id) => set((s) => ({ pins: s.pins.filter((p) => p.id !== id) })),
  updatePin: (id, updates) =>
    set((s) => ({
      pins: s.pins.map((p) => (p.id === id ? { ...p, ...updates } : p)),
    })),
  reorderPins: (orderedIds) =>
    set((s) => {
      const pinMap = new Map(s.pins.map((p) => [p.id, p]));
      const reordered = orderedIds
        .map((id, i) => {
          const pin = pinMap.get(id);
          return pin ? { ...pin, sort_order: i } : null;
        })
        .filter(Boolean) as Pin[];
      return { pins: reordered };
    }),
}));
