# Usage panel

## Scope contract

`UsagePanel` requests `/api/metrics/router-ai-usage?scope=team&period=calendar_month&days=N` first. `usage-data.ts` validates the returned source, scope, period, days, freshness and observation timestamp before accepting it. The browser never chooses a Team ID or key.

Three separate periods are displayed:

- **Monthly summary**: `usage.summary`, UTC calendar month. Do not derive it from the daily rows.
- **Team budget window**: `usage.budget_window.cost_usd`, `max_budget`, `starts_at`, and `resets_at`. Do not substitute `key.spend`, `team.spend` or the monthly total. Missing/invalid windows show `—`.
- **Usage balance**: `usage.team.spend` and `usage.team.max_budget` expose the Team's cumulative spend, configured limit, and arithmetic remainder. This is labeled separately from the exact budget window because the periods can differ. Missing/non-finite Team values suppress the balance block rather than borrowing another counter.
- **Daily usage**: the Router's rolling N-day query. The first day can be partial and N+1 dates can occur. Daily records contain `date`, `requests`, `cost_usd`, `input_tokens`, and `output_tokens`; daily token total is input + output. Zero-usage dates are omitted by the Router, so the adapter fills only gaps between the first and last returned dates. It does not invent leading/trailing full days or trim the first partial date. An empty response shows an explicit empty state.

A `stale` response stays Team-scoped but displays a warning and its original `observedAt`. Failed/mismatched Router responses try `/api/metrics/ai-usage?days=N` separately: legacy SpendLogs are a **current-key limited estimate**, and local metadata is a **current-VM estimate**, never Team totals. `key-exact` and `key-window-unverified` do not justify an exactness claim in this UI. Legacy SpendLogs `turns` counts API requests; local metadata `turns` counts assistant response records, not user turns. Unavailable numeric placeholders are discarded and displayed as `—`.

Activity charts retain their own accessible-project/user-message scope. The overall peak day and active-day count use `dailyTotals`, not the Top-N project subset. The highest-intensity cell still describes the displayed subset.

Range changes, refreshes and unmounts abort prior fetches. Late results are ignored even when a fetch implementation ignores abort. Heatmap and API usage errors are independent, so failure of either does not hide the other.

## Verification

- `usage-data.test.ts`: synthetic numeric fixtures for period/scope boundaries, unknown versus zero, legacy counts, missing dates, and Top-N invariance.
- `UsagePanel.test.tsx`: rendered behavior for Team fetch, stale warnings, VM fallback, unavailable dashes, independent errors, range races, empty daily results and refresh recovery.
- `UsagePanel.locale.source.test.ts`: locale key coverage.

These are local contract and DOM behavior tests. They do not verify deployed Router availability, actual SpendLogs accuracy, browser layout, or Fleet rollout.

Owning product contract: [AI usage metering](../../../../../docs/architecture/ai-usage-metering.md).

## Daily Team rollup adapter

`litellm-daily-team-spend` is a distinct supported source, not a SpendLogs claim. The UTC `daily_window` must span exactly the requested N calendar days with an exclusive end. The panel separates aggregate `summary.aggregated_at` from snapshot observation time, displays the Team alias, and labels cost as API cost rather than a final invoice. Exact budget-window amounts are unavailable for this source. Project breakdown and ledger reconciliation remain unverified. The sidecar working copy and its synthetic tests live in ignored operator work files; they are not a deployed product artifact.

## Model costs

Team model rows use recorded `cost_usd` (never current-rate token repricing), sorted descending with unknown costs last. USD amounts in the panel are displayed to one decimal place; reconciliation and shares use unrounded recorded amounts, so displayed row amounts may not sum exactly to the displayed total. The panel shows the top five with an accessible expansion button, relative cost bars, requests and available input/output tokens. Shares use the full monthly summary denominator, never the visible subset; zero totals, missing/negative costs or a model/summary discrepancy suppress shares. API spend is not a final invoice. `model_group` routing aliases such as smartest may combine historical models/rates; this is not a pricing history or actual-model audit. Existing project activity remains unchanged and must not be interpreted as model cost attribution.

## Daily model cost (local, not deployed)

The optional `model_daily` uses the same Team key, UTC `[starts_on, ends_before)` day range, and recorded `spend` as `daily`. A per-day stacked cost bar chart (top five routing models plus Other) is shown only when every returned daily cost reconciles; do not confuse it with the calendar-month model table or actual underlying provider model pricing. Existing project activity is unchanged. The operator sidecar change remains an ignored work copy pending its own rollout and end-to-end validation.

The monthly model table and daily tokens/table are collapsed under native details controls by default; they remain accessible without changing their scopes.
The default model area has no separate monthly-model heading; its per-day chart is independent of the optional monthly `models` list. Missing monthly models do not suppress valid daily model bars, while the monthly model table remains in details when available.

## Router request load control

`services/ai-usage/litellm-usage-snapshot.ts` reuses successful snapshots for 30 seconds, preserving the original `observedAt`. The `live` label means a recently successful observation, not a new upstream request on every refresh. Requests for the same server-resolved identity/scope/period/days share in-flight work. Snapshot and in-flight maps are each bounded to 24 entries; eviction can allow another request for an evicted in-flight key. This is process-local, not cross-process rate limiting. Failures remain retryable and retain the existing 24-hour stale fallback. Credential invalidation clears both maps and prevents old in-flight responses from repopulating or returning invalidated snapshots.

Regression coverage: `litellm-usage-snapshot.test.ts` checks ten concurrent reads producing one upstream call, TTL expiration, boundary separation, failure retry and invalidation during a request. This does not bound the legacy fallback's total timeout, deduplicate preliminary credential reads, or prove a local PostgreSQL pool exhaustion cause. Local snapshot/panel/data tests: 33 passed; typecheck passed. Deployment and live measurements remain separate.

### Legacy fallback external deadline

The legacy `listAiTokenBudgetSnapshots` path now shares an 8-second deadline between credential resolution, `/key/info` and `/spend/logs`, instead of giving the two HTTP calls separate 20/30-second timers. Credential resolution is awaited (not forcibly cancelled); an exhausted budget skips subsequent external requests. Abort-aware fetches include response-body consumption within the remaining budget. Local SQL fallback still runs and is not cancelled or time-limited by this change. Thus this is not an 8-second end-to-end API guarantee: the preceding canonical Router request, credential queries, local SQL and event-loop delays remain separate.

Lookups taking at least 2 seconds emit `[usage-fallback] slow lookup` with only stage durations (`budgetMs`, `spendLogsMs`, `localMs`, `totalMs`) and a fallback flag. These logs do not measure pool wait separately and contain no provider diagnostics or credentials. The behavior test uses a 6-second key lookup and verifies only 2 seconds remain for spend logs, local fallback runs and timers are cleared. Related local suite: 5 files / 44 tests passed; typecheck passed. No deployment or live incident attribution is implied.

### Daily model cost details

`DailyModelCostChart` in `UsagePanel.tsx` exposes a date-wide hover/focus target, including zero-cost dates. Its detail tooltip shows the date total and every underlying model's cost and request count, without collapsing the chart's “other models” bucket. Detail costs retain up to six decimal places; chart labels keep compact formatting. Keyboard focus opens details and Escape dismisses them. `UsagePanel.test.tsx` covers hover, leave, focus, and dismissal. Local verification: 14 panel tests and repository typecheck passed; browser/live deployment verification has not been performed.

## Monthly retained history

Optional `usage.monthly` contains Team-scoped UTC calendar-month rollups from `LiteLLM_DailyTeamSpend`, newest first. The table displays cost and requests for every retained month, independently of the rolling daily selection and budget counters. Missing history on older sidecars is shown as unavailable, never fabricated from daily rows. Months without records are omitted; the first retained month can be partial. The usage sidecar must supply the optional `monthly` field; sidecar deployment is separate from frontend implementation.
