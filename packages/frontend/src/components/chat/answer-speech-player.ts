let player: HTMLAudioElement | null = null;
export function getAnswerSpeechPlayer(): HTMLAudioElement {
  if (!player) { player = new Audio(); player.preload = 'auto'; player.setAttribute('playsinline', ''); }
  return player;
}
/** Called synchronously from a user gesture. Failure is handled by real playback UI. */
export function primeAnswerSpeechPlayer(): void {
  const audio = getAnswerSpeechPlayer();
  if (audio.src && !audio.paused) return;
  audio.src = 'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQIAAACAgA==';
  void audio.play().catch(() => {});
}
