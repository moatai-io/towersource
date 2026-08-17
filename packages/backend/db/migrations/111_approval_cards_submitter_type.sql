-- 111: distinguish human submissions from Primary AI team member submissions.
-- Safe additive follow-up for development DBs that applied 110 before this field
-- was added; fresh installs already receive the same column from 110.

ALTER TABLE approval_cards
  ADD COLUMN IF NOT EXISTS submitter_type TEXT NOT NULL DEFAULT 'user';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'approval_cards_submitter_type_check'
  ) THEN
    ALTER TABLE approval_cards
      ADD CONSTRAINT approval_cards_submitter_type_check
      CHECK (submitter_type IN ('user', 'workspace_agent'));
  END IF;
END $$;
