import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const service = fs.readFileSync(path.resolve(import.meta.dirname, './conversation-branch.ts'), 'utf8');
const api = fs.readFileSync(path.resolve(import.meta.dirname, '../../routes/api.ts'), 'utf8');
const sessionCoreApi = fs.readFileSync(path.resolve(import.meta.dirname, '../../routes/session-core/session-core-router.ts'), 'utf8');
const chatRuntime = fs.readFileSync(path.resolve(import.meta.dirname, '../../../frontend/src/hooks/useChatRuntime.ts'), 'utf8');

describe('conversation branch source contract', () => {
  it('supports edit-and-resend and same-request replay from one immutable prefix boundary', () => {
    expect(service).toContain("'edit_and_resend' | 'clone_through'");
    expect(service).toContain("target.role !== 'user'");
    expect(service).toContain('const boundary = `message_seq < $3`');
    expect(service).toContain("const replayPrompt = input.mode === 'clone_through' ? targetPrompt : ''");
    expect(service).toContain("input.sourceMessageId, input.sourceSessionId, 'conversation_branch'");
    expect(service).toContain('`${source.name} (과거에서 다시 시작)`');
    expect(service).toContain("visibility: source.visibility === 'project' ? 'project' : 'private'");
    expect(service).toContain('ORDER BY message_seq ASC');
  });

  it('keeps conversation branches discoverable as first-class sidebar sessions', () => {
    expect(sessionCoreApi).toContain('getSessions(userId, role, { limit, projectId, sidebarOnly: true })');
    expect(fs.readFileSync(path.resolve(import.meta.dirname, './session-manager.ts'), 'utf8')).toContain("s.parent_session_id IS NULL OR s.label IN ('spawned', 'agent', 'conversation_branch')");
    expect(chatRuntime).toContain("data.session.label === 'conversation_branch'");
    expect(chatRuntime).toContain('const isHiddenChild = !!data.session.parentSessionId && !isSidebarPeer');
  });

  it('supports destructive current-session replay by truncating at the selected user message', () => {
    expect(service).toContain('rewindConversationForReplay');
    expect(service).toContain("conversation_rewind_requires_pi_session");
    expect(service).toContain('AND message_seq < $2');
    expect(service).toContain('transaction(async (client) =>');
    expect(service).toContain('const db = withClient(client)');
    expect(service).toContain('SELECT id FROM sessions WHERE id = $1 FOR UPDATE');
    expect(service).toContain('SELECT id, role, message_seq FROM messages WHERE id = $1 AND session_id = $2 FOR UPDATE');
    expect(service).toContain('DELETE FROM messages WHERE session_id = $1 AND message_seq >= $2');
    expect(service).toContain('UPDATE sessions SET pi_session_file = $1, updated_at = NOW() WHERE id = $2');
  });

  it('requires write capability and exposes a mode-validated branch endpoint', () => {
    expect(api).toContain("'/sessions/:id/messages/:messageId/branch'");
    expect(api).toContain("mode !== 'edit_and_resend' && mode !== 'clone_through'");
    expect(api).toContain("role === 'viewer' || role === 'guest'");
    expect(api).toContain('branchConversation');
    expect(api).toContain("'/sessions/:id/branch-source'");
    expect(api).toContain('messageShortId: source.short_id');
    expect(api).toContain('conversation_branch_checkpoint_mismatch');
    expect(api).toContain('branchCreated: true');
    expect(api).toContain("'/sessions/:id/messages/:messageId/rewind-replay'");
    expect(api).toContain('rewindConversationForReplay');
  });
});
