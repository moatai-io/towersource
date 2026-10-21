ALTER TABLE secretariat_proposals ADD COLUMN IF NOT EXISTS delivery TEXT NOT NULL DEFAULT 'popup' CHECK (delivery IN ('popup','inbox'));
ALTER TABLE secretariat_runs ADD COLUMN IF NOT EXISTS diagnostic JSONB NOT NULL DEFAULT '{}'::jsonb;
