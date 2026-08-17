-- Add todo_snapshot column to tasks table
-- Stores the last TodoWrite output as JSON array for Kanban card preview
-- Format: [{"content": "...", "status": "completed|pending|in_progress"}]
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS todo_snapshot TEXT DEFAULT NULL;
