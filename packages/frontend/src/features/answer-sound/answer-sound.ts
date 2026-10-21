import { useSessionStore } from '../../stores/session-store';
/** Browser-local, account-scoped preference. No audio assets or network requests. */
let context: AudioContext | undefined;
let lastPlayed = -Infinity;
const seen = new Set<string>();
function preferenceKey() {
  return `tower:answer-sound:${localStorage.getItem('userId') || 'anonymous'}`;
}
export const ANSWER_SOUND_STYLES = ['glass', 'marimba', 'piano', 'bloom'] as const;
export type AnswerSoundStyle = typeof ANSWER_SOUND_STYLES[number];
export function getAnswerSoundStyle(): AnswerSoundStyle {
  try {
    const saved = localStorage.getItem(`${preferenceKey()}:style`);
    return ANSWER_SOUND_STYLES.includes(saved as AnswerSoundStyle) ? saved as AnswerSoundStyle : 'glass';
  } catch { return 'glass'; }
}
export function setAnswerSoundStyle(style: AnswerSoundStyle): void {
  if (!ANSWER_SOUND_STYLES.includes(style)) return;
  try { localStorage.setItem(`${preferenceKey()}:style`, style); } catch { /* Browser storage may be unavailable. */ }
}
const profiles = {
  glass: { notes: [[0, 783.99, .75], [.22, 1046.5, .95]], partials: [[1, 1, 1], [2, .12, .5], [3, .035, .3]], attack: .008 },
  marimba: { notes: [[0, 523.25, .42], [.16, 659.25, .45], [.32, 783.99, .65]], partials: [[1, 1, 1], [4, .13, .22], [10, .015, .12]], attack: .004 },
  piano: { notes: [[0, 659.25, .85], [.25, 987.77, 1.1]], partials: [[1, 1, 1], [2, .24, .75], [3, .10, .5], [4, .035, .3]], attack: .012 },
  bloom: { notes: [[0, 523.25, 1.15], [.12, 659.25, 1.15], [.24, 783.99, 1.3]], partials: [[1, 1, 1], [2, .08, .7]], attack: .045 },
};
export function isAnswerSoundEnabled(): boolean {
  try { return localStorage.getItem(preferenceKey()) === 'true'; } catch { return false; }
}
export function setAnswerSoundEnabled(enabled: boolean): Promise<boolean> {
  try { localStorage.setItem(preferenceKey(), String(enabled)); } catch { return Promise.resolve(false); }
  return enabled ? playAnswerSound() : Promise.resolve(true);
}
export async function playAnswerSound(style: AnswerSoundStyle = getAnswerSoundStyle()): Promise<boolean> {
  try {
    const AudioContextClass = globalThis.AudioContext
      || (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return false;
    if (!context || context.state === 'closed') context = new AudioContextClass();
    // Schedule while still inside the click gesture; do not wait for resume first.
    const resumed = context.resume();
    const now = context.currentTime;
    const profile = profiles[style] || profiles.glass;
    for (const [offset, frequency, noteDuration] of profile.notes) {
      for (const [ratio, level, decay] of profile.partials) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const start = now + offset;
        const duration = noteDuration * decay;
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency * ratio;
        // Smooth sampled envelope, matching the audition's soft attack and decay.
        const envelope = new Float32Array(128);
        for (let i = 0; i < envelope.length; i++) {
          const t = duration * i / (envelope.length - 1);
          envelope[i] = .18 * level * (1 - Math.exp(-t / profile.attack))
            * Math.exp(-6 * t / duration) * Math.min(1, Math.max(0, (duration - t) / .025));
        }
        gain.gain.setValueCurveAtTime(envelope, start, duration);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(start);
        oscillator.stop(start + duration + 0.02);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
      }
    }
    await resumed;
    return context.state === 'running';
  } catch { return false; /* Unsupported/blocked audio must never interrupt the chat. */ }
}
export function notifyAnswerCompleted(sessionId: string, turnId: string | undefined): void {
  notifyEvent(`answer:${sessionId}:${turnId || ''}`, !!turnId, sessionId);
}
export function notifyQuestionRequired(sessionId: string, questionId: string): void {
  notifyEvent(`question:${sessionId}:${questionId}`, !!sessionId && !!questionId, sessionId);
}
function notifyEvent(key: string, valid: boolean, sessionId: string): void {
  // Both envelope formats can carry the same terminal event; reconnects may replay it.
  if (!valid) return;
  if (seen.has(key)) return;
  seen.add(key);
  if (seen.size > 1000) seen.delete(seen.values().next().value!);
  const state = useSessionStore.getState();
  if (typeof document !== 'undefined' && document.visibilityState === 'visible'
    && document.hasFocus() && state.activeView === 'chat' && state.activeSessionId === sessionId) return;
  if (!isAnswerSoundEnabled()) return;
  const now = Date.now();
  if (now - lastPlayed < 1500) return;
  lastPlayed = now;
  // Serialize tabs on this origin; replay markers survive reconnects/reloads.
  const playOnce = () => {
    try {
      const storageKey = `${preferenceKey()}:played`;
      const previous = JSON.parse(localStorage.getItem(storageKey) || 'null');
      if (previous && (previous.key === key || now - previous.time < 1500)) return;
      localStorage.setItem(storageKey, JSON.stringify({ key, time: now }));
    } catch { /* Best effort without storage. */ }
    void playAnswerSound();
  };
  if (typeof navigator !== 'undefined' && navigator.locks) {
    void navigator.locks.request(`${preferenceKey()}:play`, playOnce).catch(() => {});
  } else playOnce();
}
