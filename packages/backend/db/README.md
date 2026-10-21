# PostgreSQL connection budget

`pg.ts` owns the process-local shared pool; `pg-pool-config.ts` validates non-secret configuration when the pool is first created. `TOWER_PG_POOL_MAX` defaults to 80 (integer 1–1000). This upper validation bound is not a sizing recommendation. `TOWER_PG_APPLICATION_NAME` accepts a 1–63 character ASCII label; absent values default to `tower-prod` for NODE_ENV=production and `tower-dev` otherwise. Use an explicit label for canaries and multiple production processes. Do not put secrets or personal data in labels. Avoid specifying a conflicting application_name in DATABASE_URL; the driver can prioritize URL options.

Budget all app processes, batches and operational connections against the database's non-reserved connection limit. Configuration takes effect on a newly created pool; no live resizing or database tuning is performed. Existing 45s idle and 8s acquisition timeouts remain unchanged.

`GET /api/admin/db-pool` uses existing operator-or-above authorization and no-store. It returns initialized, processId, max, applicationName, total, idle and waiting for the serving process only. It does not query PostgreSQL, create a pool, expose DATABASE_URL, start polling or report fleet-wide totals. Uninitialized pools report null configuration and zero counts. The label reflects configured pool options, not a server-verified application_name. Sample over time to identify saturation: a single waiting=0 does not establish healthy peak latency.

Tests: `pg-pool-config.test.ts` covers defaults, validation, constructor options, live snapshot and source-level route authorization wiring. `pg-pool-http.test.ts` exercises the exact route and role middleware over local HTTP (operator/admin allowed; absent/member/viewer/company_admin denied; no-store enforced). It extracts production source to avoid booting unrelated services, so global JWT authentication, deployment wiring and production/browser rollout remain separate verification. No database migration is required.

Local regression: 8 test files, 92 passed / 9 skipped; backend/frontend typecheck passed. Tests ran on the shared working tree, not an isolated committed build. No live settings or deployment were changed.

## WS synchronization listener ownership

`services/ws-sync.ts` intentionally reserves one pool client for LISTEN. If initialization fails after acquisition, it discards that acquired client with `release(true)` even before the global listener reference is assigned. A subsequent explicit initialization can retry; this change does not introduce automatic reconnect. `services/ws-sync-lifecycle.test.ts` covers LISTEN failure, later successful initialization, acquisition failure, duplicate initialization after success and disabled PostgreSQL. This fixes a possible failure-path leak; it is not evidence that the production incident took that path.
