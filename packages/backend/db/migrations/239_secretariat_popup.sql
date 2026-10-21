-- Automatic presentation is separate from acknowledgement; unread still blocks AI.
ALTER TABLE secretariat_proposals ADD COLUMN IF NOT EXISTS shown_at TIMESTAMPTZ;
