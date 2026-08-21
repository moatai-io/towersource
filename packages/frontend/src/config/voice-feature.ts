/** Voice is experimental and remains disabled unless a deployment explicitly opts in. */
export function isVoiceEnabled(value = import.meta.env.VITE_TOWER_VOICE_ENABLED): boolean {
  return value === 'true';
}
