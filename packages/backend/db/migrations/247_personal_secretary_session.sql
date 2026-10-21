CREATE UNIQUE INDEX IF NOT EXISTS personal_secretary_per_user ON sessions(user_id)
 WHERE label='personal_secretary' AND archived=0;
