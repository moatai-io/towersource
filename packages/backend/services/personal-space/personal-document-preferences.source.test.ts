import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../../db/migrations/140_personal_document_preferences.sql', import.meta.url), 'utf8');
const store = readFileSync(new URL('./personal-document-preferences.ts', import.meta.url), 'utf8');
const routes = readFileSync(new URL('../../routes/personal-space-api.ts', import.meta.url), 'utf8');

describe('Personal document preference sync contract', () => {
  it('stores owner-scoped preferences against active personal files', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS personal_document_preferences');
    expect(migration).toContain('PRIMARY KEY (owner_user_id, personal_file_id)');
    expect(migration).toContain('REFERENCES personal_files(id) ON DELETE CASCADE');
    expect(store).toContain('f.owner_user_id = $1 AND f.deleted_at IS NULL');
  });

  it('exposes list, pin, open, and one-time import operations', () => {
    for (const path of ["'/document-preferences'", "'/document-preferences/opened'", "'/document-preferences/pinned'", "'/document-preferences/import'"]) {
      expect(routes).toContain(path);
    }
    expect(store).toContain('ON CONFLICT(owner_user_id, personal_file_id) DO UPDATE');
    expect(store).toContain('ON CONFLICT(owner_user_id, personal_file_id) DO NOTHING');
    expect(store).toContain('.slice(0, 20)');
  });
});
