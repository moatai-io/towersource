import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './useChatRuntime.ts'), 'utf8');

describe('useChatRuntime Approval visibility', () => {
  it('does not maintain hidden Approval Card badge state from websocket events', () => {
    expect(source).not.toContain("case 'approval_card_created':");
    expect(source).not.toContain("case 'approval_card_updated':");
    expect(source).not.toContain('refreshPendingApprovals');
  });
});
