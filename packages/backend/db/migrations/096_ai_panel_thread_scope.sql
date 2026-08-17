-- AI Panel thread scope normalization.
--
-- Existing right-side Session AI threads were created as parent_session_id-bound
-- sessions with the generic label='temp'. Treat those human-created side threads
-- as personal project-visible AI threads (visible to the same user across the
-- project, not to other users). Agent backing sessions keep label='agent' and
-- remain scoped to their parent session.

UPDATE sessions
   SET label = 'ai_thread',
       visibility = 'private'
 WHERE parent_session_id IS NOT NULL
   AND room_id IS NULL
   AND user_id IS NOT NULL
   AND (label IS NULL OR label = 'temp')
   AND (archived IS NULL OR archived = 0);
