-- Tower 사용량 추적 — 모든 self-hosted server 에서 동일하게 작동.
--
-- 데이터 소스:
--   messages.input_tokens / output_tokens — turn 단위 (result 메시지마다 박힘)
--   messages.metadata.usage.cache_read_tokens / cache_creation_tokens — 2026-05-14
--     이후 박힘 (instrumentation commit 5b5bf719)
--   sessions.user_id / model_used / created_at — 세션 메타
--   users.username / role
--
-- 사용법:
--   set -a; source ~/tower/.env; set +a
--   psql "$DATABASE_URL" -f packages/backend/scripts/usage-report.sql
--   또는 특정 쿼리만:
--     psql "$DATABASE_URL" -c "$(sed -n '/-- Q1 /,/-- Q2 /p' packages/backend/scripts/usage-report.sql)"
--
-- 근거: workspace/decisions/2026-05-14-sdk-credit-economy.md

\echo '═══════════════════════════════════════════════════════════════════'
\echo ''
\echo ' Q1 — 일간 사용량 (최근 30일, 모든 사용자 합계)'
\echo ''
\echo ' 주의: input_tokens 는 *last iteration only* (mig 055 이전 의도).'
\echo '       cache 토큰은 *turn 전체 누적* (claude-engine usage.cache_*).'
\echo '       두 metric 의 단위가 다르므로 직접 비율 계산 부정확 — 별도 표시.'
\echo '═══════════════════════════════════════════════════════════════════'
SELECT
  to_char(m.created_at::date, 'YYYY-MM-DD')                                                AS day,
  COUNT(*)                                                                                  AS turns,
  ROUND(SUM(m.input_tokens) / 1e6, 1)                                                      AS input_M,
  ROUND(SUM(m.output_tokens) / 1e6, 2)                                                     AS output_M,
  ROUND(SUM(COALESCE((m.metadata->'usage'->>'cache_read_tokens')::bigint, 0)) / 1e6, 1)    AS cache_read_M_turn,
  ROUND(SUM(COALESCE((m.metadata->'usage'->>'cache_creation_tokens')::bigint, 0)) / 1e6, 1) AS cache_create_M_turn,
  ROUND(AVG(m.input_tokens))                                                                AS avg_input,
  ROUND(MAX(m.input_tokens) / 1e3)                                                          AS max_input_K
FROM messages m
WHERE m.role = 'assistant'
  AND m.input_tokens IS NOT NULL
  AND m.created_at > now() - interval '30 days'
GROUP BY 1
ORDER BY 1 DESC;

\echo ''
\echo '═══════════════════════════════════════════════════════════════════'
\echo ''
\echo ' Q2 — 사용자별 일간 사용량 (최근 14일)'
\echo ''
\echo '═══════════════════════════════════════════════════════════════════'
SELECT
  to_char(m.created_at::date, 'YYYY-MM-DD')                      AS day,
  COALESCE(u.username, '(unknown)')                              AS user,
  COUNT(*)                                                        AS turns,
  ROUND(SUM(m.input_tokens) / 1e6, 1)                            AS input_M,
  ROUND(SUM(m.output_tokens) / 1e3)                              AS output_K,
  -- 비용 추정 (Opus 4.8, premium tier 폐지 반영 — 표준 가격)
  -- 주의: input_tokens 는 last-iteration only, cache 는 cumulative 라
  --       단위 불일치. fresh_input = max(0, sum(input) - sum(cache_*))
  --       으로 lower-bound 추정. 95% cache read 가정과 결합되어 실측
  --       대비 보수적일 수 있음.
  ROUND((
    SUM(COALESCE((m.metadata->'usage'->>'cache_read_tokens')::bigint, 0)) * 1.50 +
    SUM(COALESCE((m.metadata->'usage'->>'cache_creation_tokens')::bigint, 0)) * 18.75 +
    GREATEST(
      SUM(m.input_tokens)
        - SUM(COALESCE((m.metadata->'usage'->>'cache_read_tokens')::bigint, 0))
        - SUM(COALESCE((m.metadata->'usage'->>'cache_creation_tokens')::bigint, 0)),
      0
    ) * 15.00 +
    SUM(m.output_tokens) * 75.00
  ) / 1e6, 2)                                                     AS est_usd_opus47
FROM messages m
JOIN sessions s ON s.id = m.session_id
LEFT JOIN users u ON u.id = s.user_id
WHERE m.role = 'assistant'
  AND m.input_tokens IS NOT NULL
  AND m.created_at > now() - interval '14 days'
GROUP BY 1, 2
ORDER BY 1 DESC, input_M DESC NULLS LAST
LIMIT 50;

\echo ''
\echo '═══════════════════════════════════════════════════════════════════'
\echo ''
\echo ' Q3 — 모델별 사용량 (최근 30일)'
\echo ''
\echo '═══════════════════════════════════════════════════════════════════'
SELECT
  COALESCE(s.model_used, '(null)')                                AS model,
  COUNT(DISTINCT s.id)                                            AS sessions,
  COUNT(m.id)                                                     AS turns,
  ROUND(SUM(m.input_tokens) / 1e6, 1)                            AS input_M,
  ROUND(SUM(m.output_tokens) / 1e6, 2)                           AS output_M,
  ROUND(AVG(m.input_tokens))                                      AS avg_input,
  ROUND(MAX(m.input_tokens) / 1e3)                               AS max_input_K,
  COUNT(*) FILTER (WHERE m.input_tokens > 500000)                AS over_500k_turns,
  COUNT(*) FILTER (WHERE m.input_tokens > 800000)                AS over_800k_turns
FROM sessions s
JOIN messages m ON m.session_id = s.id
WHERE m.role = 'assistant'
  AND m.input_tokens IS NOT NULL
  AND m.created_at > now() - interval '30 days'
GROUP BY 1
ORDER BY input_M DESC NULLS LAST;

\echo ''
\echo '═══════════════════════════════════════════════════════════════════'
\echo ''
\echo ' Q4 — Context size 분포 (최근 7일) — autoCompactWindow=500K 효과 측정'
\echo ''
\echo '═══════════════════════════════════════════════════════════════════'
SELECT
  CASE
    WHEN m.input_tokens < 50000   THEN '00. <50K'
    WHEN m.input_tokens < 100000  THEN '01. 50-100K'
    WHEN m.input_tokens < 200000  THEN '02. 100-200K'
    WHEN m.input_tokens < 300000  THEN '03. 200-300K'
    WHEN m.input_tokens < 500000  THEN '04. 300-500K'
    WHEN m.input_tokens < 800000  THEN '05. 500-800K (autoCompact 권역)'
    ELSE                                '06. 800K+ (압축 안 됨)'
  END                                                             AS bucket,
  COUNT(*)                                                        AS turns,
  ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1)             AS pct_turns,
  ROUND(SUM(m.input_tokens) / 1e6, 1)                            AS total_M,
  ROUND(100.0 * SUM(m.input_tokens)::numeric / SUM(SUM(m.input_tokens)) OVER (), 1) AS pct_tokens
FROM messages m
WHERE m.role = 'assistant'
  AND m.input_tokens IS NOT NULL
  AND m.created_at > now() - interval '7 days'
GROUP BY 1
ORDER BY 1;

\echo ''
\echo '═══════════════════════════════════════════════════════════════════'
\echo ''
\echo ' Q5 — Top 10 비싼 세션 (최근 30일)'
\echo ''
\echo '═══════════════════════════════════════════════════════════════════'
SELECT
  s.id::text                                                      AS session_id,
  COALESCE(u.username, '(?)')                                     AS user,
  COALESCE(s.name, '(no name)')                                   AS name,
  COUNT(m.id)                                                     AS turns,
  ROUND(SUM(m.input_tokens) / 1e6, 1)                            AS input_M,
  ROUND(SUM(m.output_tokens) / 1e3)                              AS output_K,
  ROUND(MAX(m.input_tokens) / 1e3)                               AS max_input_K,
  -- 비용 추정 (Opus 4.8, 95% cache read 가정)
  ROUND((
    SUM(COALESCE((m.metadata->'usage'->>'cache_read_tokens')::bigint, 0)) * 1.50 +
    SUM(COALESCE((m.metadata->'usage'->>'cache_creation_tokens')::bigint, 0)) * 18.75 +
    GREATEST(SUM(m.input_tokens)
      - SUM(COALESCE((m.metadata->'usage'->>'cache_read_tokens')::bigint, 0))
      - SUM(COALESCE((m.metadata->'usage'->>'cache_creation_tokens')::bigint, 0)), 0
    ) * 15.00 +
    SUM(m.output_tokens) * 75.00
  ) / 1e6, 2)                                                     AS est_usd
FROM sessions s
JOIN messages m ON m.session_id = s.id
LEFT JOIN users u ON u.id = s.user_id
WHERE m.role = 'assistant'
  AND m.input_tokens IS NOT NULL
  AND m.created_at > now() - interval '30 days'
GROUP BY s.id, u.username, s.name
ORDER BY est_usd DESC NULLS LAST
LIMIT 10;

\echo ''
\echo '═══════════════════════════════════════════════════════════════════'
\echo ''
\echo ' Q6 — Cache instrumentation 적용 후 데이터 커버리지 (검증용)'
\echo ''
\echo '═══════════════════════════════════════════════════════════════════'
SELECT
  to_char(m.created_at::date, 'YYYY-MM-DD')                      AS day,
  COUNT(*)                                                        AS total_turns,
  COUNT(*) FILTER (WHERE m.metadata ? 'usage')                   AS with_cache_data,
  ROUND(100.0 * COUNT(*) FILTER (WHERE m.metadata ? 'usage')
                / NULLIF(COUNT(*), 0), 1)                         AS coverage_pct
FROM messages m
WHERE m.role = 'assistant'
  AND m.input_tokens IS NOT NULL
  AND m.created_at > '2026-05-13'
GROUP BY 1
ORDER BY 1 DESC;

\echo ''
\echo '═══════════════════════════════════════════════════════════════════'
\echo ' 참고: 비용 추정은 Opus 4.8 기준 ($15 input / $75 output / cache_read $1.50 / cache_write $18.75 per MTok)'
\echo ' Premium tier surcharge 는 2026-03-13 폐지 (1M context 전 범위 표준 가격)'
\echo '═══════════════════════════════════════════════════════════════════'
