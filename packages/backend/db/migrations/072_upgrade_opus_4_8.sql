-- Claude Opus 4.7 → 4.8 일괄 업그레이드 (2026-05-30)
-- 기존 세션, 태스크, 자동화, 스케줄에서 Opus 4.7을 4.8로 전환.
-- 027_upgrade_opus_4_7.sql 패턴 답습.

-- ── Sessions ──
UPDATE sessions
SET model_used = 'claude-opus-4-8'
WHERE model_used = 'claude-opus-4-7';

-- ── Tasks (legacy, archived 포함) ──
UPDATE tasks
SET model = 'claude-opus-4-8'
WHERE model = 'claude-opus-4-7';

-- ── Automations (unified tasks + schedules) ──
UPDATE automations
SET model = 'claude-opus-4-8'
WHERE model = 'claude-opus-4-7';

-- ── Schedules (legacy, automations로 이미 마이그된 데이터지만 안전 차원) ──
UPDATE schedules
SET model = 'claude-opus-4-8'
WHERE model = 'claude-opus-4-7';
