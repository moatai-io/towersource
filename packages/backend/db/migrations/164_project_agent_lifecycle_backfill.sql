-- 164: Backfill explicit retirement lifecycle for legacy archived Projects.
-- Kept separate from the schema ALTER to avoid a long mixed DDL/DML lock.
UPDATE projects
   SET lifecycle_status = 'retired',
       retired_at = COALESCE(retired_at, NOW())
 WHERE archived = 1
   AND lifecycle_status = 'active';
