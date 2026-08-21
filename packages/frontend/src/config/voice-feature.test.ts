import { describe, expect, it } from 'vitest';
import { isVoiceEnabled } from './voice-feature';

describe('voice feature flag', () => {
  it('remains off unless explicitly enabled', () => {
    expect(isVoiceEnabled(undefined)).toBe(false);
    expect(isVoiceEnabled('false')).toBe(false);
    expect(isVoiceEnabled('true')).toBe(true);
  });
});
