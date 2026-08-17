-- ============================================================
-- 148: sessions.kind — deployed agent conversation classification
--
-- `deployment` identifies external agent conversations persisted as Tower
-- Sessions. They remain available under the reserved `배포 세션` deck, but the
-- default Chats/Subagents/Runs filters hide them; only All includes them.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_sessions_kind_deployment
  ON sessions (kind, updated_at DESC)
  WHERE kind = 'deployment';
