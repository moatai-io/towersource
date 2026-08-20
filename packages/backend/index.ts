import express from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { config, validateConfig } from './config.js';
import apiRouter from './routes/api.js';
import gatewayRouter from './routes/gateway.js';
import workbenchWorkerRouter from './routes/workbench-worker-api.js';
import voiceApiRouter from './routes/voice-api.js';
import { setupWebSocket, broadcastToAll, broadcastToUser, dispatchDueAgentTurnRetries, serverSideResumeInterrupted } from './routes/ws-handler.js';
import { initPg, closePgPool, isPgEnabled } from './db/pg.js';
import { stopFileWatcher } from './services/workspace/file-system.js';
import { initWorkspaceRepo } from './services/git/git-manager.js';
import { resumeOrphanedTaskMonitoring, hasMonitoredTasks, stopAllMonitors } from './services/task/task-runner.js';
import { recoverRunningAgentRunsOnStartup, startAgentRunSettlementRecovery, stopAgentRunSettlementRecovery } from './services/agent-workers.js';
import { cleanupOrphanedSdkProcesses, stopOrphanMonitor, gracefulShutdown, consumeInterruptedSessions, type InterruptedSession } from './services/ai/claude-sdk.js';
import { consumeInterruptedPiSessionDetails } from './services/ai/pi-session-runtime.js';
import { shutdownEngines } from './engines/index.js';
import { startUnifiedScheduler, stopUnifiedScheduler } from './services/task/unified-scheduler.js';
import { startReconciler as startPublishingReconciler, stopReconciler as stopPublishingReconciler } from './services/publishing/reconciler.js';
import { THUMBNAILS_DIR } from './services/publishing/thumbnail-generator.js';
import { activeSiteMetadata } from './routes/ai-service-public-api.js';
import { initNotificationHub } from './services/notification-hub.js';
import { startSessionMemoryCardDueScanner, stopSessionMemoryCardDueScanner } from './services/ai/session-memory-card.js';
import { auditStaleSessions } from './services/session/session-manager.js';
import { startEmptySessionCleanup, stopEmptySessionCleanup } from './services/session/empty-session-cleanup.js';
import { startAgentWorkerCleanup, stopAgentWorkerCleanup } from './services/agent-worker-cleanup.js';
import { findOrphanedStartedAgentTurns } from './services/message-store.js';
import { expireUnsafeRestartRecoveryTurns, interruptRestartedWaitingUserTurns } from './services/agent-turn/turn-supervisor.js';
import { startAgentTurnDispatcher, stopAgentTurnDispatcher } from './services/agent-turn/turn-dispatcher.js';
import { stopWsSync } from './services/ws-sync.js';
import { setupRuntimeBoxPreviewWebSocket } from './services/runtime-box/preview-proxy.js';
import { bootstrapLibraryProviders } from './services/skill/skill-registry.js';
import { backfillTaskProjects } from './services/task/task-manager.js';
import { scheduleResumableUploadStartupCleanup } from './services/uploads/resumable-upload-cleanup.js';
import { VERSION, GIT_SHA } from './utils/pkg-info.js';

// CRITICAL: Remove CLAUDECODE env var before anything else
delete process.env.CLAUDECODE;
// Session resilience v1 — findJsonlFile + interrupted auto-resume

// Refuse to start with insecure JWT secret
validateConfig();

const app = express();
app.set('trust proxy', 1); // trust first proxy (Cloudflare) — correct IP for rate limiting
app.use(helmet({
  contentSecurityPolicy: false,       // breaks Vite HMR + inline scripts
  crossOriginEmbedderPolicy: false,   // breaks iframe embeds
}));
app.use(cors());
app.use(compression({ threshold: 512 })); // gzip responses > 512 bytes
app.use(express.json({ limit: '10mb' }));

// Gateway routes (full mode only — MUST be before /api catch-all)
if (config.towerRole === 'full') {
  app.use('/api/gateway', gatewayRouter);
  console.log('[gateway] Central Publish Gateway enabled (TOWER_ROLE=full)');
}

// Worker control-plane routes use their own scoped identity boundary and must be
// mounted before the broad API router. Browser/operator endpoints inside the router
// still apply the normal Tower auth middleware.
app.use('/api/workbench-workers', workbenchWorkerRouter);
app.use('/api', voiceApiRouter);

// API routes
app.use('/api', apiRouter);

// Public, generated Publishing Hub thumbnails. Site files themselves are served
// by nginx from workspace/published/sites/<slug>/; thumbnails are platform-owned
// metadata for the Hub UI.
app.use('/published-thumbnails', express.static(THUMBNAILS_DIR(), {
  fallthrough: true,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    // Publishing Hub can run on desk-dev/customer origins while thumbnails are
    // served by the canonical Tower host (and legacy desk URLs may redirect).
    // Explicitly permit cross-origin embedding instead of Chromium applying
    // the default same-origin CORP policy after the redirect.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('X-Robots-Tag', 'noindex');
  },
}));

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isSharePreviewCrawler(userAgent: unknown): boolean {
  return /facebookexternalhit|Facebot|Twitterbot|Slackbot|Discordbot|LinkedInBot|kakaotalk-scrap|TelegramBot|Google-InspectionTool/i.test(String(userAgent || ''));
}

function agentFaceAssetUrl(metadata: Record<string, unknown>, baseUrl: string): string | undefined {
  const face = typeof metadata.face === 'string' ? metadata.face : '';
  if (!face.startsWith('character:')) return undefined;
  const id = face.slice('character:'.length).replace(/[^a-zA-Z0-9_-]/g, '');
  return id ? `${baseUrl}/agent-characters/${encodeURIComponent(id)}.webp` : undefined;
}

function renderAgentShareCardSvg(metadata: Record<string, unknown>, baseUrl: string): string {
  const name = escapeHtml(metadata.name || '배포된 AI 에이전트');
  const description = escapeHtml(metadata.tagline || metadata.description || 'Tower AI Service');
  const face = agentFaceAssetUrl(metadata, baseUrl);
  const faceMarkup = face ? `<image href="${escapeHtml(face)}" x="92" y="118" width="300" height="300" preserveAspectRatio="xMidYMid slice" clip-path="url(#faceClip)"/>` : '<text x="242" y="292" text-anchor="middle" fill="#dbeafe" font-size="120" font-family="sans-serif">AI</text>';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><defs><linearGradient id="bg" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#0f172a"/><stop offset="1" stop-color="#134e4a"/></linearGradient><clipPath id="faceClip"><rect x="92" y="118" width="300" height="300" rx="44"/></clipPath></defs><rect width="1200" height="630" fill="url(#bg)"/><circle cx="1030" cy="-40" r="270" fill="#2dd4bf" opacity=".13"/><rect x="92" y="118" width="300" height="300" rx="44" fill="#1e293b"/>${faceMarkup}<text x="480" y="205" fill="#99f6e4" font-size="24" font-weight="700" font-family="sans-serif">TOWER AI AGENT</text><text x="480" y="290" fill="white" font-size="56" font-weight="700" font-family="sans-serif">${name}</text><text x="480" y="350" fill="#cbd5e1" font-size="28" font-family="sans-serif">${description.slice(0, 90)}</text><text x="480" y="510" fill="#94a3b8" font-size="22" font-family="sans-serif">공개된 자료와 허용된 기능으로 답변합니다</text></svg>`;
}

// Serve frontend in production
const frontendPath = config.frontendDir;
if (fs.existsSync(frontendPath)) {
  // sw.js & index.html must never be cached — ensures PWA updates propagate immediately
  // CDN-Bypass: Cloudflare respects CDN-Cache-Control separately from browser Cache-Control
  app.get('/sw.js', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(frontendPath, 'sw.js'));
  });
  app.get('/ai/:channelId/share-card.svg', async (req, res) => {
    try {
      const metadata = await activeSiteMetadata(String(req.params.channelId));
      const baseUrl = (config.sharePublicUrl || config.publicUrl || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.type('svg').send(renderAgentShareCardSvg(metadata, baseUrl));
    } catch {
      res.status(404).type('text').send('Not found');
    }
  });

  app.get(['/ai/:channelId', '/ai-service-chat/:channelId'], async (req, res, next) => {
    if (!isSharePreviewCrawler(req.get('user-agent'))) return next();
    try {
      const channelId = String(req.params.channelId);
      const metadata = await activeSiteMetadata(channelId);
      const baseUrl = (config.sharePublicUrl || config.publicUrl || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
      const title = escapeHtml(metadata.name || '배포된 AI 에이전트');
      const description = escapeHtml(metadata.tagline || metadata.description || 'Tower AI Service');
      const imageUrl = `${baseUrl}/ai/${encodeURIComponent(channelId)}/share-card.svg`;
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.type('html').send(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title><meta name="description" content="${description}"><meta property="og:title" content="${title}"><meta property="og:description" content="${description}"><meta property="og:type" content="website"><meta property="og:url" content="${escapeHtml(baseUrl + req.originalUrl)}"><meta property="og:image" content="${escapeHtml(imageUrl)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${title}"><meta name="twitter:description" content="${description}"><meta name="twitter:image" content="${escapeHtml(imageUrl)}"></head><body><h1>${title}</h1><p>${description}</p></body></html>`);
    } catch {
      next();
    }
  });

  app.use(express.static(frontendPath, {
    setHeaders: (res, filePath) => {
      // Hashed assets (e.g. index-DRQj5zgr.js) can be cached forever; everything else gets revalidation
      if (filePath.includes('/assets/')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));
  app.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(frontendPath, 'index.html'));
  });
}

const server = http.createServer(app);
setupWebSocket(server);
setupRuntimeBoxPreviewWebSocket(server);

// Initialize workspace git repo
initWorkspaceRepo(config.workspaceRoot).catch((err) => {
  console.error('[Git] Failed to initialize workspace repo:', err);
});

server.listen(config.port, config.host, async () => {
  const candidatePassiveMode = process.env.TOWER_CANDIDATE_PASSIVE_MODE === 'true';
  const shaSuffix = GIT_SHA ? ` (${GIT_SHA.slice(0, 7)})` : '';
  console.log(`
╔══════════════════════════════════════════╗
║  Tower v${VERSION}${shaSuffix}
║  http://localhost:${config.port}
║  Auth: ${config.authEnabled ? 'enabled' : 'disabled'}
║  CWD: ${config.defaultCwd.slice(0, 40)}
╚══════════════════════════════════════════╝
  `);

  // Initialize PostgreSQL (restart trigger) (chat rooms — v3.0 dual DB)
  if (isPgEnabled()) {
    try {
      await initPg();
      console.log('[pg] PostgreSQL initialized — chat rooms enabled');
      try {
        const { initializeRuntimeBoxCapacity } = await import('./services/runtime-box/runtime-box-capacity.js');
        await initializeRuntimeBoxCapacity();
      } catch (err) {
        console.warn('[runtime-box] Failed to load persisted capacity settings:', err);
      }
      scheduleResumableUploadStartupCleanup();
      // Seed default projects (currently General only) — idempotent
      try {
        const { seedDefaultProjects } = await import('./services/pm/project-manager.js');
        const ids = await seedDefaultProjects();
        if (ids.length > 0) console.log(`[projects] Default projects ready (${ids.length})`);
      } catch (err) {
        console.warn('[projects] Failed to seed default projects:', err);
      }
      // Internal chat_rooms channels are being retired. Existing rows remain
      // readable/executable during migration, but startup must not create new
      // Tower system or Personal AI channels. Execution reports move to the
      // Notification Hub; external ai_service_channels are unaffected.
      // Backfill project_id for orphaned tasks (cwd → project root_path matching)
      backfillTaskProjects().then(({ updated, total }) => {
        if (updated > 0) console.log(`[tasks] Backfilled project_id for ${updated}/${total} orphaned tasks`);
      }).catch(err => console.error('[tasks] Backfill failed:', err));

      // Backfill short_code for sessions/rooms created before migrations 067/070 (issue #11 Phase 2).
      // 결정: workspace/decisions/2026-05-24-url-routing-phase-2-short-code.md
      (async () => {
        const { backfillSessionShortCodes } = await import('./services/session/session-manager.js');
        return backfillSessionShortCodes();
      })().then((updated) => {
        if (updated > 0) console.log(`[sessions] Backfilled short_code for ${updated} sessions`);
      }).catch(err => console.error('[sessions] short_code backfill failed:', err));

      (async () => {
        const { backfillRoomShortCodes } = await import('./services/room/room-manager.js');
        return backfillRoomShortCodes();
      })().then((updated) => {
        if (updated > 0) console.log(`[rooms] Backfilled short_code for ${updated} rooms`);
      }).catch(err => console.error('[rooms] short_code backfill failed:', err));

      // Backfill short_id for messages created before migration 069 (issue #11 Phase 3).
      // 27만+ rows 라 batched (500/회), fire-and-forget — 부팅을 차단하지 않음.
      (async () => {
        const { backfillMessageShortIds } = await import('./services/message-store.js');
        return backfillMessageShortIds();
      })().then((updated) => {
        if (updated > 0) console.log(`[messages] Backfilled short_id for ${updated} messages`);
      }).catch(err => console.error('[messages] short_id backfill failed:', err));

      // Backfill short_id for room_messages created before migration 071 (issue #11 채널 앵커).
      // 수백 rows 정도라 빠름.
      (async () => {
        const { backfillRoomMessageShortIds } = await import('./services/room/room-manager.js');
        return backfillRoomMessageShortIds();
      })().then((updated) => {
        if (updated > 0) console.log(`[room-messages] Backfilled short_id for ${updated} room_messages`);
      }).catch(err => console.error('[room-messages] short_id backfill failed:', err));
    } catch (err) {
      console.error('[pg] Failed to initialize — chat rooms will be unavailable:', err);
    }
  } else {
    console.log('[pg] DATABASE_URL not set — chat rooms disabled');
  }

  // 2026-04-17: company 스킬은 DB에 저장하지 않음. library.yaml + ~/.claude/skills/
  // 가 단일 소스. 여기선 library 스킬의 frontmatter에서 provider 요구사항만 읽어
  // skill_providers 테이블에 반영한다. (workspace/decisions/2026-04-17-skill-db-simplification.md)
  try {
    const result = await bootstrapLibraryProviders();
    console.log(`[startup] Library providers synced=${result.synced}, orphans_removed=${result.orphansRemoved}`);
  } catch (err) {
    console.error('[startup] bootstrapLibraryProviders failed:', err);
  }

  // 2026-05-07: reconcile shared asset symlinks across all Claude accounts so
  // non-default configDirs (e.g. ~/.claude-gmail) inherit skills/agents/hooks/
  // CLAUDE.md/settings.json from the default account. Without this, an account
  // registered before this code shipped — or via raw DB INSERT — boots up with
  // missing user skills and missing settings.json hooks.
  // 결정: workspace/decisions/2026-05-07-claude-account-asset-symlinks.md
  try {
    const { reconcileAccountAssetSymlinks } = await import('./services/auth/credential-store.js');
    const reports = await reconcileAccountAssetSymlinks();
    for (const { account, result } of reports) {
      if (result.linked.length > 0 || result.backedUp.length > 0) {
        console.log(
          `[startup] account-symlinks ${account}: ` +
          `linked=${result.linked.length} (${result.linked.join(',')}), ` +
          `backed_up=${result.backedUp.length}, skipped=${result.skipped.length}`
        );
      }
    }
  } catch (err) {
    console.error('[startup] reconcileAccountAssetSymlinks failed:', err);
  }

  // Phase 1 1a — Execution sandbox connectivity check.
  // 4계층 토글 1단계(서버 .env) + ssh 도달성을 동시 검증. 실패 시 sandbox
  // 도구는 등록되지 않음. ENABLE_SANDBOX=false 면 즉시 무시 (정상 비활성).
  // 결정: workspace/decisions/2026-04-24-execution-sandbox-scope.md (D8)
  try {
    const { initSandbox } = await import('./services/deploy/sandbox-ssh.js');
    await initSandbox();
  } catch (err) {
    console.warn('[startup] sandbox init unexpected error:', err);
  }

  // Phase 2a-1 — long-running internal tools 의 만료 cron.
  // 매 시간 expires_at 지난 컨테이너를 docker stop + DB status='expired'.
  // sandbox 자체가 비활성이면 cron 도 무의미하지만, sandbox 활성 시 자동 시작.
  // 결정: workspace/decisions/2026-04-29-execution-sandbox-q13-tool-start-api.md
  if (!candidatePassiveMode && process.env.ENABLE_SANDBOX?.toLowerCase() === 'true') {
    try {
      const { startToolExpirationCron } = await import('./services/deploy/sandbox-tools.js');
      startToolExpirationCron();
      console.log('[sandbox-tools] expiration cron started (hourly)');
    } catch (err) {
      console.warn('[startup] sandbox-tools cron start failed:', err);
    }
  }

  // Project Runtime Box — idle-stop cron (60s tick).
  // ENABLE_PROJECT_RUNTIME_BOX=false 이면 cron 시작 안 함 (기본값).
  // 결정: workspace/decisions/2026-06-02-project-runtime-box-product-framing.md
  if (!candidatePassiveMode && config.runtimeBox.enabled) {
    try {
      const { startRuntimeBoxCron } = await import('./services/runtime-box/idle-stop-cron.js');
      startRuntimeBoxCron();
    } catch (err) {
      console.warn('[startup] runtime-box cron start failed:', err);
    }
  }

  if (candidatePassiveMode) {
    console.warn('[startup] Candidate passive mode enabled: schedulers, recovery, cleanup, proactive agent, and background reconcilers are disabled.');
  }

  // Load interrupted sessions from previous shutdown (before stale cleanup).
  // A passive candidate must not consume the primary backend's handoff files.
  // Combine Claude + Pi interrupted sessions for unified auto-resume.
  const interruptedSessions: InterruptedSession[] = candidatePassiveMode ? [] : consumeInterruptedSessions();
  const piInterruptedSessions = candidatePassiveMode ? [] : consumeInterruptedPiSessionDetails();
  if (piInterruptedSessions.length > 0) {
    console.log(`[startup] Recovered ${piInterruptedSessions.length} interrupted Pi session(s)`);
    // Pi sessions store their engine session file path in DB. Preserve the root
    // user-turn identity in the shutdown handoff so restart recovery does not
    // depend solely on a later checkpoint lookup.
    for (const session of piInterruptedSessions) {
      interruptedSessions.push({
        id: session.id,
        userMessageId: session.rootTurnId,
        recoverySource: 'shutdown-file',
      });
    }
  }

  // AskUserQuestion's resolver belongs to the previous process and cannot be
  // reconstructed after restart. Fail these turns closed before the generic
  // orphan scan, otherwise startup auto-resume can continue without the user's
  // required answer and leave the UI/run state wedged.
  if (!candidatePassiveMode) {
    try {
      const interruptedAuqTurns = await interruptRestartedWaitingUserTurns();
      if (interruptedAuqTurns.length > 0) {
        const interruptedAuqSessions = new Set(interruptedAuqTurns.map((turn) => turn.sessionId));
        for (let i = interruptedSessions.length - 1; i >= 0; i--) {
          if (interruptedAuqSessions.has(interruptedSessions[i].id)) interruptedSessions.splice(i, 1);
        }
        console.warn(`[startup] Marked ${interruptedAuqTurns.length} AskUserQuestion turn(s) needs_attention after restart`);
      }
    } catch (err) {
      console.warn('[startup] interrupted AskUserQuestion cleanup failed:', err);
    }
  }

  // Restart recovery is only for current, recent work. Old durable `running`
  // rows and turns superseded by a newer user message are unsafe to replay: they
  // can repeat tools and make inactive sessions look recently active.
  if (!candidatePassiveMode) {
    try {
      const expiredTurns = await expireUnsafeRestartRecoveryTurns({ maxAgeHours: 24 });
      if (expiredTurns.length > 0) {
        const expiredRootIds = new Set(expiredTurns.map((turn) => turn.rootTurnId));
        for (let i = interruptedSessions.length - 1; i >= 0; i--) {
          if (interruptedSessions[i].userMessageId && expiredRootIds.has(interruptedSessions[i].userMessageId!)) {
            interruptedSessions.splice(i, 1);
          }
        }
        const stale = expiredTurns.filter((turn) => turn.reason === 'stale').length;
        const superseded = expiredTurns.length - stale;
        console.warn(`[startup] Skipped ${expiredTurns.length} unsafe restart recovery turn(s): stale=${stale} superseded=${superseded}`);
      }
    } catch (err) {
      console.warn('[startup] unsafe restart recovery cleanup failed:', err);
    }
  }

  // DB checkpoint fallback: if PM2 restarts after a user message was saved but
  // before any assistant row gained content, shutdown-time interrupted files may
  // miss the session. A passive candidate must not claim or advertise the
  // primary backend's recoverable turns.
  if (!candidatePassiveMode) {
    try {
      const existingIds = new Set(interruptedSessions.map(s => s.id));
      const orphans = await findOrphanedStartedAgentTurns({ excludeSessionIds: [...existingIds] });
      for (const orphan of orphans) {
        interruptedSessions.push({
          id: orphan.session_id,
          claudeSessionId: orphan.engine_session_id || undefined,
          userMessageId: orphan.message_id,
          recoverySource: 'db-agent-turn-checkpoint',
        });
      }
      if (orphans.length > 0) {
        console.log(`[startup] Recovered ${orphans.length} orphaned agent turn checkpoint(s) from DB`);
      }
    } catch (err) {
      console.warn('[startup] orphaned agent turn checkpoint scan failed:', err);
    }
  }

  if (interruptedSessions.length > 0) {
    // Store globally so ws-handler can check during reconnect (client-side fallback)
    (globalThis as any).__interruptedSessions = new Set(interruptedSessions.map(s => s.id));
    // Also store full details for server-side auto-resume
    (globalThis as any).__interruptedSessionDetails = interruptedSessions;
  }

  if (!candidatePassiveMode) {
    // Audit stale sessions (missing .jsonl) — log only, never clear claude_session_id.
    // Clearing causes permanent context loss. Instead, sdk.ts throws explicit error on resume.
    auditStaleSessions();

    // Recover tasks that survived the restart, then start orphan monitor.
    // The monitor only kills idle orphans (CPU < 1% for 2 checks), so it's safe
    // to run alongside monitored tasks — active task processes won't be touched.
    resumeOrphanedTaskMonitoring((type, payload) => broadcastToAll({ type, ...payload }));
    cleanupOrphanedSdkProcesses();

    // Start unified scheduler (checks every 30s for due schedules + legacy tasks)
    startUnifiedScheduler((type, payload) => broadcastToAll({ type, ...payload }));

    // Session memory cards — refresh only changed sessions whose last card is stale.
    // This is not a blind inactive-session loop: it requires turn_count > covered_turn_count.
    startSessionMemoryCardDueScanner();

    // Archive accidental sessions that remained completely untouched for over 24 hours.
    startEmptySessionCleanup();

    // Archive idle/failed persistent workers untouched for 30 days. This only hides
    // the worker and backing session; run history, messages, files, and JSONL remain.
    startAgentWorkerCleanup();

    // Publishing reconciler — 5-min disk → manifest sync. Safety net for sites
    // the PostToolUse hook missed (Bash mkdir, ssh direct, backend down during
    // creation). See packages/backend/services/publishing/README.md.
    startPublishingReconciler();
  }

  // Initialize notification hub — routes notifications to specific users via WS
  const notifBroadcast = (type: string, data: any) => {
    if (type === 'notification' && data.targetUserId) {
      broadcastToUser(data.targetUserId, { type: 'notification', notification: data.notification });
    } else if (type === 'room_message') {
      broadcastToAll({ type, ...data });
    } else {
      broadcastToAll({ type, ...data });
    }
  };
  initNotificationHub(notifBroadcast);

  // Initialize proactive agent (AI-initiated conversations)
  if (!candidatePassiveMode) {
    const { initProactiveAgent } = await import('./services/ai/proactive-agent.js');
    initProactiveAgent(notifBroadcast);
  }

  // Initialize L3 session-spawn RPC (parent session → sidebar peer)
  // See: workspace/decisions/2026-05-09-l3-session-spawn-rpc.md
  // 2026-05-10 wake-stealth-turn fix: also wire flushPendingUserMessages so
  // wake-triggered turns drain user-chat queue with same precedence as
  // ws-handler engine_done hook (user > wake).
  const { initSpawnRpc, restorePendingCallbacks } = await import(
    './services/session/spawn-rpc.js'
  );
  const { flushPendingUserMessages } = await import('./routes/ws-handler.js');
  initSpawnRpc(notifBroadcast, flushPendingUserMessages);

  // Phase 3 PR 2 (2026-05-10): restore pending spawn callbacks from DB so
  // children that were mid-flight at restart still inject their answers when
  // their engine.run finally resumes. Decision: 2026-05-09-l3-spawn-phase3.
  if (!candidatePassiveMode) {
    restorePendingCallbacks().catch((err) =>
      console.warn('[startup] restorePendingCallbacks failed (non-fatal):', err),
    );
    const { startDeliveryPump } = await import('./services/agent-communication/delivery-pump.js');
    const { recoverDurableSessionSend, recoverDurableAgentReport } = await import('./services/session/spawn-rpc.js');
    startDeliveryPump({
      dependencies: {
        decidePolicy: async () => ({ action: 'deliver' }),
        deliver: async (message) => message.kind === 'report'
          ? recoverDurableAgentReport(message)
          : recoverDurableSessionSend(message),
      },
    }).catch((err) => console.warn('[startup] Agent delivery pump failed (non-fatal):', err));
  }

  // Agent Control Plane: re-arm settlement for worker runs that were running
  // before a backend restart. The backing Agent Session may be auto-resumed by
  // serverSideResumeInterrupted(); this sweep prevents agent_runs/state cards
  // from staying stuck as running/queued after the session becomes idle. Keep a
  // light periodic sweep too: a worker can continue longer than the immediate
  // post-restart retry window and still needs its parent report rescued later.
  if (!candidatePassiveMode) {
    recoverRunningAgentRunsOnStartup().catch((err) =>
      console.warn('[startup] recoverRunningAgentRunsOnStartup failed (non-fatal):', err),
    );
    startAgentRunSettlementRecovery();
  }

  // (heartbeat scheduler 제거 — 2026-04-28-heartbeat-deprecation.md Phase 4-B)

  // Server-side auto-resume: proactively resume interrupted sessions without waiting
  // for a client WebSocket reconnect. This fixes the gap where background-only sessions
  // or sessions with no active browser tab would be permanently lost.
  // Runs async — does not block server startup.
  if (!candidatePassiveMode) {
    startAgentTurnDispatcher({ dispatch: dispatchDueAgentTurnRetries });
    serverSideResumeInterrupted().catch(err => {
      console.error('[auto-resume] Failed to resume interrupted sessions:', err);
    });
  }
});

// Graceful shutdown — let orphan CLI processes keep running.
//
// gracefulShutdown() (claude-sdk module-level) + shutdownEngines() (per-engine)
// must run FIRST and SYNCHRONOUSLY so the interrupted-*.json files are flushed
// to disk before pm2's SIGKILL fallback (default KILL_TIMEOUT=1.6s) can fire.
// Without shutdownEngines(), Pi sessions silently disappear across restarts
// because no one writes interrupted-pi-sessions.json.
// See: workspace/decisions/2026-05-17-restart-interrupted-session-recovery-fix.md
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  void import('./services/agent-communication/delivery-pump.js').then(({ stopDeliveryPump }) => stopDeliveryPump());
  gracefulShutdown('SIGINT');
  shutdownEngines().catch(err => console.error('[shutdown] engines:', err));
  stopUnifiedScheduler();
  stopAgentTurnDispatcher();
  stopSessionMemoryCardDueScanner();
  stopEmptySessionCleanup();
  stopAgentWorkerCleanup();
  stopAgentRunSettlementRecovery();
  stopOrphanMonitor();
  stopPublishingReconciler();
  stopAllMonitors();
  stopFileWatcher();
  stopWsSync().catch(() => {}).finally(() => {
    closePgPool().finally(() => server.close(() => process.exit(0)));
  });
});

process.on('SIGTERM', () => {
  void import('./services/agent-communication/delivery-pump.js').then(({ stopDeliveryPump }) => stopDeliveryPump());
  gracefulShutdown('SIGTERM');
  shutdownEngines().catch(err => console.error('[shutdown] engines:', err));
  stopUnifiedScheduler();
  stopAgentTurnDispatcher();
  stopSessionMemoryCardDueScanner();
  stopEmptySessionCleanup();
  stopAgentWorkerCleanup();
  stopAgentRunSettlementRecovery();
  stopOrphanMonitor();
  stopPublishingReconciler();
  stopAllMonitors();
  stopFileWatcher();
  stopWsSync().catch(() => {}).finally(() => {
    closePgPool().finally(() => server.close(() => process.exit(0)));
  });
});

// Prevent SDK "Operation aborted" errors from crashing the entire backend.
// These occur when abort() is called while the SDK is mid-write to a dead process.
process.on('uncaughtException', (err) => {
  if (err.name === 'AbortError' || /operation aborted/i.test(err.message)) {
    console.warn('[process] Caught AbortError (non-fatal):', err.message);
    return; // swallow — expected during session abort
  }
  console.error('[process] Uncaught exception (fatal):', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason: any) => {
  if (reason?.name === 'AbortError' || /operation aborted/i.test(reason?.message || '')) {
    console.warn('[process] Caught unhandled AbortError rejection (non-fatal):', reason?.message);
    return;
  }
  console.error('[process] Unhandled rejection:', reason);
});
