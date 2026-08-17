import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../../..');
const config = fs.readFileSync(path.join(root, 'packages/backend/config.ts'), 'utf8');
const pg = fs.readFileSync(path.join(root, 'packages/backend/db/pg.ts'), 'utf8');
const api = fs.readFileSync(path.join(root, 'packages/backend/routes/api.ts'), 'utf8');
const pi = fs.readFileSync(path.join(root, 'packages/backend/engines/pi-engine.ts'), 'utf8');
const bubble = fs.readFileSync(path.join(root, 'packages/frontend/src/components/chat/MessageBubble.tsx'), 'utf8');

describe('Turn Rewind managed rollout gate', () => {
  it('defaults self-hosted deployment VMs on and exposes one explicit rollback/defer hatch', () => {
    expect(config).toContain("turnRewindEnabled: process.env.TOWER_TURN_REWIND_ENABLED !== 'false'");
    expect(pg).toContain("if (env.TOWER_TURN_REWIND_ENABLED !== 'false') return false");
    expect(api).toContain('turnRewindEnabled: config.turnRewindEnabled');
  });

  it('keeps capture, API, and UI behind the same runtime gate while migrations are fleet-deployable by default', () => {
    expect(pg).toContain("MANAGED_DEFERRED_MIGRATION_PREFIXES = ['158_turn_file_checkpoints', '159_messages_message_seq']");
    expect(pi).toContain('config.turnRewindEnabled && opts.rootTurnId && opts.sessionProjectRoot');
    expect(api).toContain("if (!config.turnRewindEnabled) return res.status(404).json({ error: 'conversation_branch_unavailable' })");
    expect(bubble).toContain('turnRewindEnabled && activeSessionId');
  });
});
