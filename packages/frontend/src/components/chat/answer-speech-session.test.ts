import { beforeEach, describe, expect, it } from 'vitest';
import { eligibleSpeechMessage, useSpeechSession } from './answer-speech-session';
describe('session narration ownership', () => {
 beforeEach(() => useSpeechSession.setState({ recording: {}, consumed: {}, owner: null }));
 it('accepts new completed responses without requiring text growth', () => {
  expect(eligibleSpeechMessage({enabledAt:10,timestamp:20,newerQuestion:false,recording:false,hidden:false,interrupted:false})).toBe(true);
 });
 it('excludes recording, older replies and later questions', () => {
  const base={enabledAt:10,timestamp:20,newerQuestion:false,recording:false,hidden:false,interrupted:false};
  expect(eligibleSpeechMessage({...base,recording:true})).toBe(false);
  expect(eligibleSpeechMessage({...base,timestamp:5})).toBe(false);
  expect(eligibleSpeechMessage({...base,newerQuestion:true})).toBe(false);
 });
 it('serializes different messages and remembers consumed text', () => {
  const s=useSpeechSession.getState();
  expect(s.claim('a')).toBe(true); expect(s.claim('b')).toBe(false);
  s.commit('a','읽었습니다.'); s.release('a');
  expect(s.claim('b')).toBe(true); expect(useSpeechSession.getState().consumed.a).toBe('읽었습니다.');
 });
});
