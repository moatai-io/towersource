-- Bind persistent channel Agent memory to the audience/resource authority
-- snapshot under which it was created. A changed fingerprint rotates the
-- engine session before another public channel response can use old context.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS channel_authority_fingerprint TEXT;

CREATE INDEX IF NOT EXISTS idx_sessions_channel_authority_fingerprint
  ON sessions(room_id, channel_authority_fingerprint)
  WHERE room_id IS NOT NULL AND label IN ('channel_ai', 'channel_agent');
