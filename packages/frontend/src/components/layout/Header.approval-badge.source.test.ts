import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const header = fs.readFileSync(path.resolve(import.meta.dirname, './Header.tsx'), 'utf8');
const runtime = fs.readFileSync(path.resolve(import.meta.dirname, '../../hooks/useChatRuntime.ts'), 'utf8');

describe('Approval UI visibility contract', () => {
  it('keeps Approval badge and polling out of the app shell while the feature is hidden', () => {
    expect(header).not.toContain('pendingApprovalCount');
    expect(header).not.toContain('refreshPendingApprovals');
    expect(header).not.toContain('APPROVAL_CARDS_CHANGED_EVENT');
    expect(header).not.toContain('useApprovalStore');
  });

  it('does not refresh a hidden Approval inbox from chat websocket events', () => {
    expect(runtime).not.toContain("case 'approval_card_created':");
    expect(runtime).not.toContain("case 'approval_card_updated':");
    expect(runtime).not.toContain('refreshPendingApprovals');
  });
});
