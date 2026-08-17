-- Add username column to messages table for accurate speaker attribution
-- Nullable: existing messages will have NULL (frontend falls back to session owner)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS username TEXT;

-- Index for future "my messages" queries
CREATE INDEX IF NOT EXISTS idx_messages_username ON messages(username);
