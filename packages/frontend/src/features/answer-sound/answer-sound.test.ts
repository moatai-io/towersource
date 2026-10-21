import { beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  const values = new Map<string, string>([['userId', '7']]);
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
});
it('defaults off and scopes the preference to the current account', async () => {
  const sound = await import('./answer-sound');
  expect(sound.isAnswerSoundEnabled()).toBe(false);
  sound.setAnswerSoundEnabled(true);
  expect(sound.isAnswerSoundEnabled()).toBe(true);
  localStorage.setItem('userId', '8');
  expect(sound.isAnswerSoundEnabled()).toBe(false);
});
it('deduplicates terminal envelopes and coalesces simultaneous completions', async () => {
  const resume = vi.fn(async () => {});
  vi.stubGlobal('AudioContext', class { state = 'suspended'; resume = resume; });
  const sound = await import('./answer-sound');
  localStorage.setItem('tower:answer-sound:7', 'true');
  sound.notifyAnswerCompleted('a', '1');
  sound.notifyAnswerCompleted('a', '1');
  sound.notifyAnswerCompleted('b', '2');
  expect(resume).toHaveBeenCalledTimes(1);
});
it('ignores completion facts without a stable turn ID and tolerates blocked audio', async () => {
  vi.stubGlobal('AudioContext', class { constructor() { throw new Error('blocked'); } });
  const sound = await import('./answer-sound');
  localStorage.setItem('tower:answer-sound:7', 'true');
  expect(() => sound.notifyAnswerCompleted('a', undefined)).not.toThrow();
  await expect(sound.playAnswerSound()).resolves.toBe(false);
});
it('chimes for a new question only once and keeps question IDs separate from turn IDs', async () => {
  const resume = vi.fn(async () => {});
  vi.stubGlobal('AudioContext', class { state = 'suspended'; resume = resume; });
  const now = vi.spyOn(Date, 'now');
  now.mockReturnValue(10000);
  try {
    const sound = await import('./answer-sound');
    localStorage.setItem('tower:answer-sound:7', 'true');
    sound.notifyQuestionRequired('a', '1');
    now.mockReturnValue(12000);
    sound.notifyQuestionRequired('a', '1');
    expect(resume).toHaveBeenCalledTimes(1);
    sound.notifyAnswerCompleted('a', '1');
    expect(resume).toHaveBeenCalledTimes(2);
  } finally { now.mockRestore(); }
});
it('does not chime for questions when disabled or missing identifiers', async () => {
  const resume = vi.fn(async () => {});
  vi.stubGlobal('AudioContext', class { state = 'suspended'; resume = resume; });
  const sound = await import('./answer-sound');
  sound.notifyQuestionRequired('a', '1');
  localStorage.setItem('tower:answer-sound:7', 'true');
  sound.notifyQuestionRequired('', '2');
  sound.notifyQuestionRequired('a', '');
  expect(resume).not.toHaveBeenCalled();
});

it('reports unavailable audio instead of claiming preview success', async () => {
  vi.resetModules();
  vi.stubGlobal('AudioContext', undefined);
  vi.stubGlobal('webkitAudioContext', undefined);
  const sound = await import('./answer-sound');
  expect(await sound.playAnswerSound()).toBe(false);
  vi.unstubAllGlobals();
});

it('schedules default glass bell strikes with quiet overtones and cleans up nodes', async () => {
  const oscillators: any[] = [];
  const gains: any[] = [];
  vi.stubGlobal('AudioContext', class {
    state = 'running'; currentTime = 10; destination = {};
    resume = vi.fn(async () => {});
    createOscillator() {
      const oscillator = { frequency: { value: 0 }, type: '', connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: undefined as any };
      oscillators.push(oscillator);
      return oscillator;
    }
    createGain() {
      const gain = { gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn(), setValueCurveAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() };
      gains.push(gain);
      return gain;
    }
  });
  try {
    const sound = await import('./answer-sound');
    expect(await sound.playAnswerSound()).toBe(true);
    expect(oscillators).toHaveLength(6);
    expect(oscillators[0].frequency.value).toBe(783.99);
    expect(oscillators[3].frequency.value).toBe(1046.5);
    expect(oscillators[0].start).toHaveBeenCalledWith(10);
    expect(oscillators[3].start).toHaveBeenCalledWith(10.22);
    expect(oscillators[3].stop).toHaveBeenCalledWith(11.19);
    expect(gains[0].gain.setValueCurveAtTime).toHaveBeenCalledWith(expect.any(Float32Array), 10, .75);
    oscillators.forEach((oscillator, index) => {
      oscillator.onended();
      expect(oscillator.disconnect).toHaveBeenCalledOnce();
      expect(gains[index].disconnect).toHaveBeenCalledOnce();
    });
  } finally { vi.unstubAllGlobals(); }
});


it('defaults to glass, persists per account, and rejects unknown stored styles', async () => {
  const sound = await import('./answer-sound');
  expect(sound.getAnswerSoundStyle()).toBe('glass');
  for (const style of sound.ANSWER_SOUND_STYLES) {
    sound.setAnswerSoundStyle(style);
    expect(sound.getAnswerSoundStyle()).toBe(style);
  }
  localStorage.setItem('userId', '8');
  expect(sound.getAnswerSoundStyle()).toBe('glass');
  localStorage.setItem('tower:answer-sound:8:style', 'unknown');
  expect(sound.getAnswerSoundStyle()).toBe('glass');
});

it('does not chime for the visibly focused session', async () => {
  const resume = vi.fn(async () => {});
  vi.stubGlobal('document', { visibilityState: 'visible', hasFocus: () => true });
  vi.stubGlobal('AudioContext', class { state = 'running'; resume = resume; });
  try {
    const { useSessionStore } = await import('../../stores/session-store');
    useSessionStore.setState({ activeSessionId: 'viewed', activeView: 'chat' });
    const sound = await import('./answer-sound');
    localStorage.setItem('tower:answer-sound:7', 'true');
    sound.notifyAnswerCompleted('viewed', 'turn');
    sound.notifyQuestionRequired('viewed', 'question');
    expect(resume).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});
