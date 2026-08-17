import { describe, expect, it } from 'vitest';
import { filterPendingSteerMessages } from './pending-steer-filter';

describe('filterPendingSteerMessages', () => {
  it('hides streaming DB user messages that are still pending Pi steers', () => {
    const messages = [
      { id: 'assistant-1', role: 'assistant' as const },
      { id: 'steer-1', role: 'user' as const },
      { id: 'user-2', role: 'user' as const },
    ];

    expect(filterPendingSteerMessages(messages, [{ id: 'steer-1' }], true)).toEqual([
      { id: 'assistant-1', role: 'assistant' },
      { id: 'user-2', role: 'user' },
    ]);
  });

  it('keeps the same DB user message once the session is idle', () => {
    const messages = [{ id: 'steer-1', role: 'user' as const }];
    expect(filterPendingSteerMessages(messages, [{ id: 'steer-1' }], false)).toBe(messages);
  });
});
