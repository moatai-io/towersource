-- 177: Private AI run trace events for non-transcript lifecycle signals.
--
-- This table deliberately stays out of messages.content so chat history, search,
-- share links, transcript reads, and model rehydration do not replay or expose
-- provider-private reasoning/commentary. Store structural signals only by default.

CREATE TABLE IF NOT EXISTS ai_run_trace_events (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  root_turn_id   TEXT,
  message_id     TEXT,
  project_id     TEXT,
  actor_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  engine         TEXT NOT NULL,
  model          TEXT,
  event_type     TEXT NOT NULL CHECK (event_type IN (
                   'thinking_start',
                   'thinking_end',
                   'thinking_signal',
                   'commentary_signal',
                   'progress_status',
                   'provider_reasoning_metric',
                   'trace_redaction_notice'
                 )),
  visibility     TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'operator')),
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_run_trace_events_session_time
  ON ai_run_trace_events(session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_run_trace_events_root_turn_time
  ON ai_run_trace_events(root_turn_id, created_at DESC)
  WHERE root_turn_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_run_trace_events_project_time
  ON ai_run_trace_events(project_id, created_at DESC)
  WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_run_trace_events_event_time
  ON ai_run_trace_events(event_type, created_at DESC);

COMMENT ON TABLE ai_run_trace_events IS
  'Private structural AI run trace. Excluded from default chat transcript/search/share/model rehydration; raw chain-of-thought should not be stored here by default.';

COMMENT ON COLUMN ai_run_trace_events.payload IS
  'Redacted structured metadata only by default: timings, phase, counts, token metrics, active tool name/id. Do not store raw thinking/commentary text without an explicit future retention policy.';
