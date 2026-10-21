-- tower:migration-lock-risk-reviewed
-- Lock review: UPDATE below is a stored trigger function body, not a migration-time
-- backfill. All indexes target newly created empty tables; no existing rows are rewritten.
-- Foreign-key creation and CREATE TRIGGER still lock referenced tables/users briefly.
-- Bound lock acquisition so busy production traffic aborts this transaction rather
-- than leaving a migration waiting indefinitely. Retry only after inspecting state.
SET LOCAL lock_timeout = '5s';

-- Company administrator participation is never ordinary Project/room membership.
CREATE TABLE administrator_participations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  room_id TEXT REFERENCES chat_rooms(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at TIMESTAMPTZ,
  CHECK ((project_id IS NOT NULL)::integer + (room_id IS NOT NULL)::integer = 1)
);
CREATE UNIQUE INDEX administrator_participation_project ON administrator_participations(user_id, project_id) WHERE project_id IS NOT NULL;
CREATE UNIQUE INDEX administrator_participation_room ON administrator_participations(user_id, room_id) WHERE room_id IS NOT NULL;

-- Deliberately no cascading FKs: immutable security evidence survives target deletion.
CREATE TABLE administrator_participation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participation_id UUID NOT NULL,
  actor_user_id INTEGER NOT NULL,
  project_id TEXT,
  room_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('joined', 'left', 'role_revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX administrator_participation_events_target ON administrator_participation_events(project_id, room_id, created_at DESC);

-- Once downgraded/disabled, an old participation must not revive on re-promotion.
CREATE FUNCTION revoke_administrator_participation_on_role_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.role = 'operator' AND (NEW.role <> 'operator' OR NEW.disabled <> 0) THEN
    WITH revoked AS (
      UPDATE administrator_participations SET left_at = now()
      WHERE user_id = NEW.id AND left_at IS NULL RETURNING *
    )
    INSERT INTO administrator_participation_events(participation_id, actor_user_id, project_id, room_id, event_type)
    SELECT id, NEW.id, project_id, room_id, 'role_revoked' FROM revoked;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER revoke_administrator_participation AFTER UPDATE OF role, disabled ON users
FOR EACH ROW EXECUTE FUNCTION revoke_administrator_participation_on_role_change();

CREATE FUNCTION reject_administrator_participation_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Administrator participation audit events are append-only';
END;
$$;
CREATE TRIGGER administrator_participation_events_immutable BEFORE UPDATE OR DELETE ON administrator_participation_events
FOR EACH ROW EXECUTE FUNCTION reject_administrator_participation_event_mutation();
