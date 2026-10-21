import { create } from 'zustand';
/** Session state survives virtualized message unmounts; no persistence across reloads. */
export const useSpeechSession = create<{
  recording: Record<string, boolean>;
  consumed: Record<string, string>;
  owner: string | null;
  setRecording: (session: string, value: boolean) => void;
  claim: (key: string) => boolean;
  release: (key: string) => void;
  commit: (key: string, prefix: string) => void;
}>((set, get) => ({
  recording: {}, consumed: {}, owner: null,
  setRecording: (session, value) => set(s => ({ recording: { ...s.recording, [session]: value } })),
  claim: key => { if (get().owner && get().owner !== key) return false; set({ owner: key }); return true; },
  release: key => { if (get().owner === key) set({ owner: null }); },
  commit: (key, prefix) => set(s => ({ consumed: { ...s.consumed, [key]: prefix } })),
}));
export function eligibleSpeechMessage(opts: { enabledAt: number; timestamp: number; newerQuestion: boolean; recording: boolean; hidden: boolean; interrupted: boolean }): boolean {
  return opts.enabledAt > 0 && opts.timestamp >= opts.enabledAt && !opts.newerQuestion && !opts.recording && !opts.hidden && !opts.interrupted;
}
