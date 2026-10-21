// @vitest-environment jsdom
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceConversationButton } from './VoiceConversationButton';
vi.mock('livekit-client', () => ({ Room: vi.fn(), RoomEvent: {} }));
vi.mock('react-i18next', () => ({ useTranslation: () => { throw new Error('Disabled voice must not mount media component'); } }));
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });
describe('voice component default-off boundary', () => {
  it.each([undefined, 'false', 'TRUE', '1'])('does not mount voice hooks when flag=%s', (value) => {
    vi.stubEnv('VITE_TOWER_VOICE_ENABLED', value);
    const { container } = render(<VoiceConversationButton sessionId="test-session" />);
    expect(container.childElementCount).toBe(0);
  });
});
