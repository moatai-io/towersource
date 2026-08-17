-- 133: Separate immutable Harness version publication from current-version promotion.

ALTER TABLE harness_versions ADD COLUMN IF NOT EXISTS promotion_status TEXT;
ALTER TABLE harness_versions ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ;
ALTER TABLE harness_versions ADD COLUMN IF NOT EXISTS promoted_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE harness_versions ADD COLUMN IF NOT EXISTS promotion_decision_id TEXT REFERENCES harness_eval_promotion_decisions(id) ON DELETE RESTRICT;

UPDATE harness_versions v
   SET promotion_status = CASE WHEN h.current_version=v.version THEN 'promoted' ELSE 'candidate' END,
       promoted_at = CASE WHEN h.current_version=v.version THEN COALESCE(v.promoted_at,v.published_at,v.created_at) ELSE v.promoted_at END
  FROM harnesses h
 WHERE h.id=v.harness_id AND v.promotion_status IS NULL;

ALTER TABLE harness_versions ALTER COLUMN promotion_status SET DEFAULT 'candidate';
ALTER TABLE harness_versions ALTER COLUMN promotion_status SET NOT NULL;
ALTER TABLE harness_versions DROP CONSTRAINT IF EXISTS harness_versions_promotion_status_check;
ALTER TABLE harness_versions ADD CONSTRAINT harness_versions_promotion_status_check
  CHECK (promotion_status IN ('candidate','promoted','rejected'));

ALTER TABLE harness_drafts DROP CONSTRAINT IF EXISTS harness_drafts_status_check;
ALTER TABLE harness_drafts ADD CONSTRAINT harness_drafts_status_check
  CHECK (status IN ('draft','validating','valid','invalid','candidate','published','abandoned'));

CREATE INDEX IF NOT EXISTS idx_harness_versions_candidates
  ON harness_versions(harness_id,promotion_status,version DESC);

CREATE OR REPLACE FUNCTION harness_current_version_requires_promotion() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.current_version > 0 AND NOT EXISTS (
    SELECT 1 FROM harness_versions v
     WHERE v.harness_id=NEW.id AND v.version=NEW.current_version
       AND v.status='published' AND v.promotion_status='promoted'
  ) THEN
    RAISE EXCEPTION 'Harness current_version must reference a promoted immutable version';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_harness_current_version_requires_promotion ON harnesses;
CREATE CONSTRAINT TRIGGER trg_harness_current_version_requires_promotion
AFTER INSERT OR UPDATE OF current_version ON harnesses
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION harness_current_version_requires_promotion();
