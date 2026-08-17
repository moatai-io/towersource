import { create } from 'zustand';
export type { PromptItem } from '@tower/shared';
import type { PromptItem } from '@tower/shared';

interface PromptState {
  prompts: PromptItem[];
  expanded: boolean;
  setPrompts: (prompts: PromptItem[]) => void;
  addPrompt: (prompt: PromptItem) => void;
  removePrompt: (id: number | string) => void;
  updatePrompt: (id: number | string, updates: Partial<Pick<PromptItem, 'title' | 'content'>>) => void;
  setExpanded: (v: boolean) => void;
}

export const usePromptStore = create<PromptState>((set) => ({
  prompts: [],
  expanded: false,
  setPrompts: (prompts) => set({ prompts }),
  addPrompt: (prompt) => set((s) => ({ prompts: [prompt, ...s.prompts] })),
  removePrompt: (id) => set((s) => ({ prompts: s.prompts.filter((p) => p.id !== id) })),
  updatePrompt: (id, updates) =>
    set((s) => ({
      prompts: s.prompts.map((p) => (p.id === id ? { ...p, ...updates } : p)),
    })),
  setExpanded: (v) => set({ expanded: v }),
}));
