-- Claude Opus 4.6 → 4.7 일괄 업그레이드 (2026-04-17)
-- 기존 세션, 태스크, 자동화, 스케줄에서 Opus 4.6을 4.7로 전환

-- ── Sessions ──
UPDATE sessions
SET model_used = 'claude-opus-4-7'
WHERE model_used = 'claude-opus-4-6';

-- ── Tasks (legacy, archived 포함) ──
UPDATE tasks
SET model = 'claude-opus-4-7'
WHERE model = 'claude-opus-4-6';

-- ── Automations (unified tasks + schedules) ──
UPDATE automations
SET model = 'claude-opus-4-7'
WHERE model = 'claude-opus-4-6';

-- ── Schedules (legacy, automations로 이미 마이그된 데이터지만 안전 차원) ──
UPDATE schedules
SET model = 'claude-opus-4-7'
WHERE model = 'claude-opus-4-6';
