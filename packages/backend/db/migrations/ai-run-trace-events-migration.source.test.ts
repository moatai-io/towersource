import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('./177_ai_run_trace_events.sql', import.meta.url), 'utf8');

describe('ai run trace events migration', () => {
  it('creates a private structural trace table outside messages.content', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS ai_run_trace_events');
    expect(migration).toContain('session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE');
    expect(migration).toContain('root_turn_id   TEXT');
    expect(migration).toContain("'thinking_start'");
    expect(migration).toContain("'thinking_end'");
    expect(migration).toContain("'commentary_signal'");
    expect(migration).toContain("'progress_status'");
    expect(migration).toContain("visibility     TEXT NOT NULL DEFAULT 'private'");
    expect(migration).toContain('idx_ai_run_trace_events_session_time');
    expect(migration).toContain('Excluded from default chat transcript/search/share/model rehydration');
    expect(migration).not.toMatch(/raw_text|chain_of_thought_text|reasoning_text/i);
    expect(migration).not.toMatch(/secret|credential|password|api[_-]?key/i);
  });
});
