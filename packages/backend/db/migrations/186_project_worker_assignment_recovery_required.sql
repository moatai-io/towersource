-- Binding activation succeeded but assignment audit finalization may still fail.
-- Preserve that post-binding ambiguity as recovery_required instead of retrying
-- preparation automatically and potentially rotating a healthy Worker again.

ALTER TABLE project_worker_assignment_desires
  DROP CONSTRAINT IF EXISTS project_worker_assignment_desires_status_check;

ALTER TABLE project_worker_assignment_desires
  ADD CONSTRAINT project_worker_assignment_desires_status_check
  CHECK (status IN ('pending','preparing','active','failed','recovery_required','cancelled'));
