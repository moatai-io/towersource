import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.join(process.cwd(), 'packages/backend/db/migrations/127_ai_service_preview_runtime.sql'), 'utf8');

describe('AI Service Preview runtime migration', () => {
  it('pins each Service Conversation to at most one private Tower runtime Session', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS runtime_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL');
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_service_conversations_runtime_session');
    expect(migration).toContain('WHERE runtime_session_id IS NOT NULL');
  });
});
