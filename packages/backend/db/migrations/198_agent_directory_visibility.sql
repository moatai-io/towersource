-- Discovery is independent of project membership and Session/file ACLs.
-- There was no Project visibility column before this migration. Preserve every
-- existing Agent as unreviewed rather than guessing which names are safe to publish.
ALTER TABLE projects ADD COLUMN directory_visibility TEXT NOT NULL DEFAULT 'unlisted'
  CHECK (directory_visibility IN ('listed', 'unlisted', 'confidential'));
-- Only newly created Agents are listed by default. Owners can explicitly mark
-- confidential Agents or approve an existing Agent for the company directory.
ALTER TABLE projects ALTER COLUMN directory_visibility SET DEFAULT 'listed';
COMMENT ON COLUMN projects.directory_visibility IS
  'Company directory metadata only. unlisted = awaiting review; confidential = explicit hidden exception. Never grants workspace access.';
