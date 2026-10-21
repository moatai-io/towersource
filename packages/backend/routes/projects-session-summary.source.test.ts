import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './api.ts'), 'utf8');
const projectsRoute = source.slice(
  source.indexOf("router.get('/projects'"),
  source.indexOf("router.get('/channel-agents'"),
);

describe('project session summary contract', () => {
  it('returns accessible first-class conversation counts independent from the startup 200-session window', () => {
    expect(projectsRoute).toContain('COUNT(*)::int session_count');
    expect(projectsRoute).toContain('MAX(s.updated_at) last_session_at');
    expect(projectsRoute).toContain("s.parent_session_id IS NULL OR s.label IN ('spawned','agent','conversation_branch')");
    expect(projectsRoute).toContain("s.room_id IS NULL OR s.label='channel_ai'");
    expect(projectsRoute).toContain("s.user_id IS NULL OR s.user_id=$2 OR s.visibility='project'");
    expect(projectsRoute).toContain('sessionCount:Number(row.session_count)||0');
    expect(projectsRoute).toContain('lastSessionAt:row.last_session_at||null');
  });
});
