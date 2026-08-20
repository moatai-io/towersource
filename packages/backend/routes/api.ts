import { Response, Router } from 'express';
import { deriveAgentCareerLevel, highestAgentCareerLevel, type AgentCareerLevel, type AgentCareerMetrics } from '@tower/shared';
import multer from 'multer';
import path from 'path';
import os from 'os';
import http from 'http';
import runtimeBoxRouter from './runtime-box-api.js';
import credentialVaultRouter from './credential-vault-api.js';
import resumableUploadRouter from './resumable-upload-api.js';
import personalSpaceRouter from './personal-space-api.js';
import sessionAttachmentRouter from './session-attachment-api.js';
import fileExchangeRouter from './file-exchange-api.js';
import projectFilesRouter from './project-files/project-files-router.js';
import { resolveWorkerFileAuthorityForHostPath, uploadWorkerProjectFile } from '../services/runtime-box/workbench-project-file-authority.js';
import { mirrorWorkerProjectMutation } from '../services/runtime-box/workbench-project-derived-mirror.js';
import sessionCoreRouter from './session-core/session-core-router.js';
import { isPathAllowedByCoarseRootOrAcl } from './project-files/project-files-access.js';
import aiServiceRouter from './ai-service-api.js';
import aiServicePublicRouter from './ai-service-public-api.js';
import workspaceAppsRouter from './workspace-apps-api.js';
import harnessRouter from './harness-api.js';
import primaryAgentRouter from './primary-agent-api.js';
import {
  authenticateUser, createUser, hasUsers, generateToken, generateScopedToken, verifyToken, authMiddleware, extractToken,
  adminMiddleware, operatorOrAboveMiddleware, listUsers, updateUserRole,
  resetUserPassword, disableUser, getUserAllowedPath, getUserRole,
  updateUserProfile, updateUserUsername, changeOwnPassword, getOwnProfile,
  UsernameTakenError, InvalidUsernameError,
} from '../services/auth/auth.js';
import {
  approveSignupUser,
  createSignupInviteCode,
  deleteSignupInviteCode,
  InvalidInviteCodeError,
  listSignupInviteCodes,
  recommendInviteCode,
  rejectSignupUser,
  requestSignup,
  updateSignupInviteCode,
} from '../services/auth/signup-invites.js';
import { getAiComposerSettings, getSignupApprovalMode, setAiComposerSettings, setSignupApprovalMode } from '../services/settings/app-settings.js';
import {
  createSession, getSession, updateSession, deleteSession,
  getArchivedSessions, restoreSession, permanentlyDeleteSession,
  scanClaudeNativeSessions,
  cloneSession,
  recordEngineSwitch,
} from '../services/session/session-manager.js';
import { branchConversation, rewindConversationForReplay, type ConversationBranchMode } from '../services/session/conversation-branch.js';
import { getRelatedSessionsByFiles } from '../services/session/session-backlinks.js';
import { deleteUserSessionAttention, getUserSessionAttention, upsertUserSessionAttention } from '../services/session/session-attention.js';
import { getTouchedFiles } from '../services/session/session-touched-files.js';
import { getProjectRecentFiles } from '../services/session/session-project-files.js';
import { applyConfirmedCheckpointRestore, previewCheckpointRestore } from '../services/agent-turn/file-checkpoint-restore.js';
import { getCheckpointOwner, getTurnCheckpoint, loadCheckpointFileChanges } from '../services/agent-turn/file-checkpoint-repo.js';
import { getProjectActivityGraph } from '../services/session/project-activity-graph.js';
import { getFileTree, getFileTreeAsync, invalidateTreeCache, readFile, writeFile, writeFileBinary, isPathSafe, isPathWritable, createDirectory, deleteEntry, renameEntry, copyEntry, expandHome } from '../services/workspace/file-system.js';
import fs from 'fs';
import archiver from 'archiver';
import { getCommandsForUser, listSkills, getSkill, getSkillRegistryDoctor, copySkillToPersonal, createSkill, updateSkill, deleteSkill, setUserSkillPref, getUserSkillPref, bootstrapLibraryProviders, shareProjectSkillToCompany } from '../services/skill/skill-registry.js';
import { loadProjectAgentDefinitions, saveProjectAgentDefinition } from '../services/agent-definitions.js';
import { repinSessionProjectAgentProfile } from '../services/pm/project-agent-profile.js';
import { invalidateLibraryCache } from '../services/skill/library-skills.js';
import { getMessages, saveMessage } from '../services/message-store.js';
import { switchEngine } from '../services/session/engine-switch.js';
import { getEngine } from '../engines/index.js';
import { v4 as uuidv4 } from 'uuid';
import { generateSessionName } from '../services/auto-namer.js';
import { generateSummary } from '../services/ai/summarizer.js';
import { runUtilityTextTask } from '../services/ai/utility-agent.js';
import {
  getPins, createPin, updatePin, deletePin, reorderPins,
  createPromptPin, updatePromptPin, getPromptsWithCommands,
} from '../services/pin-manager.js';
import {
  getLog, getFileDiff, manualCommit, rollbackToCommit,
} from '../services/git/git-manager.js';
import { config, availableModels, loadModelsFile, saveModelsFile, reloadModels, getModelDefaults, normalizePiSessionModelId } from '../config.js';
import { getInferenceProviderReadiness } from '../services/ai/inference-provider-readiness.js';
import { configureInferenceProvider, inferenceSetupStatus, probeInferenceProvider, type PublicInferenceProvider } from '../services/ai/inference-provider-setup.js';
import { oauthManager } from '../services/auth/oauth-manager-instance.js';
import { isGoogleOAuthConfigured, getGoogleAuthUrl, exchangeGoogleCode, getGoogleUserInfo, GOOGLE_DEFAULT_SCOPES } from '../services/auth/google-oauth.js';
import { findOAuthProvider, listOAuthProviders } from '../services/auth/oauth-provider-registry.js';
import { setSecret, SecretAccessDeniedError } from '../services/secret/secret-store.js';
import { upsertAgentGwsCredential, upsertOrganizationGwsCredential } from '../services/credential-vault/credential-vault-service.js';
import { AgentCharacterGenerationError, generateAgentCharacter, generatedCharacterPath } from '../services/agent-character/generated-character.js';
import { search } from '../services/workspace/search.js';
import { scanNotesIndex, type NotesIndexMode } from '../services/workspace/notes-index.js';
import { buildWorkspaceKnowledgeGraph } from '../services/workspace/knowledge-graph.js';
import { extractTextFromContent } from '../utils/text.js';
import { getVersionInfo } from '../utils/pkg-info.js';
import { createTask, getTasks, getTask, updateTask, deleteTask, reorderTasks, getDistinctCwds, getArchivedTasks, restoreTask, permanentlyDeleteTask, getChildTasks, backfillTaskProjects } from '../services/task/task-manager.js';
import { removeWorktree } from '../services/git/worktree-manager.js';
import { broadcast, broadcastToAll, broadcastToUser, disconnectUserSockets } from './ws-handler.js';
import { appendMeetingChunk, createMeetingRun, endMeetingRun, getMeetingRun, type MeetingAudioSource } from '../services/meeting-recorder/meeting-recorder.js';
import {
  createInternalShare, createExternalShare, getSharesByFile,
  getSharesWithMe, getExternalSharesByOwner, getShareByToken, revokeShare, isTokenValid,
  hasInternalShareForUser,
} from '../services/workspace/share-manager.js';
import { createFileLink, getFileLinkByShortId } from '../services/workspace/file-link-manager.js';
import { appendFileTransferEventSafe } from '../services/workspace/file-transfer-audit.js';
import fsPromises from 'fs/promises';
import { execute, query, queryOne } from '../db/pg-repo.js';
import {
  getProjects, getProject, createProject, updateProject, retireProject, restoreProject,
  moveSessionToProject, reorderProjects, saveUserProjectPins,
} from '../services/pm/project-manager.js';
import { listAdminAgents, previewAgentPurge } from '../services/pm/agent-purge-preview.js';
import { createAgentPurgeJob, getAgentPurgeJob, runAgentPurgeJob } from '../services/pm/agent-purge-job.js';
import { ensureProjectAgentInstruction } from '../services/pm/project-agent-instruction.js';
import {
  listSpaces, createSpace, updateSpace, deleteSpace,
} from '../services/space-manager.js';
import {
  getProjectMembers, addProjectMember, removeProjectMember,
  isProjectOwner, isProjectMember, getAccessibleProjectIds, getProjectMembershipIds,
} from '../services/pm/project-membership-manager.js';
import {
  canAccessSession, canDeleteSession, canAccessRoom, canAccessTask, canCreateInProject, isPathAccessible,
  isPathWritableByRole, isPrivilegedRole, isAdminOrOperator, isDotfileDenied, resolveSessionProjectRoot,
} from '../services/pm/project-access.js';
import {
  createInternalSessionShare, createExternalSessionShare,
  getSharesBySession, getSessionSharesWithMe,
  getSessionShareByToken, revokeSessionShare, isSessionShareValid,
} from '../services/session/session-share-manager.js';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { runInlineEdit, appendInlineEditAudit } from '../services/inline-edit/index.js';
import { listAccessibleCustomerNames, userCanAccessCustomerName } from '../services/auth/customer-scope.js';
import { inspectCadMetadata, isCadRenderEnabled, renderCadToCachedImage, startCadRenderIfNeeded } from '../engines/pi-cad-view-tool.js';
import { decodeTextBuffer } from '../services/workspace/text-encoding.js';
import {
  createCrossProjectMaintenanceGrant,
  listCrossProjectMaintenanceGrants,
  revokeCrossProjectMaintenanceGrant,
} from '../services/pm/cross-project-maintenance.js';
import { getChallengeTimeline } from '../services/work/challenge-timeline.js';
import { getWorkLedgerHealth } from '../services/work/work-ledger-health.js';
import {
  deleteSkillWorkbenchTestCase,
  isSkillWorkbenchEnabled,
  listSkillWorkbenchHistory,
  listSkillWorkbenchTestCases,
  runSkillWorkbenchComparison,
  saveSkillWorkbenchTestCase,
} from '../services/skill-workbench/skill-workbench.js';

// Max upload size per file. Override with UPLOAD_MAX_SIZE env var (MB).
// Keep in sync with nginx `client_max_body_size` on tower.tower.example.com / desk-dev.tower.example.com.
// See workspace/decisions/2026-04-24-file-upload-limits-and-inline-detection.md
const UPLOAD_MAX_SIZE = (parseInt(process.env.UPLOAD_MAX_SIZE || '') || 200) * 1024 * 1024; // default 200MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: UPLOAD_MAX_SIZE,
    // Folder drops can produce many parts — bump the defaults so multer/busboy
    // don't bail out with "Field value too long" or "Too many parts" mid-stream.
    fieldSize: 10 * 1024 * 1024,  // 10MB for the relativePaths JSON blob
    fields: 50,                   // text fields (we only send 2-3, headroom)
    files: 500,                   // matches UPLOAD_MAX_FILES below
    parts: 1000,                  // total parts (text + files)
  },
  fileFilter: (_req, file, cb) => {
    // Fix Korean/CJK filenames: multer decodes as Latin-1, re-decode as UTF-8
    file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, true);
  },
});

const PROJECT_UPLOAD_STAGING_DIR = path.join(config.dataDir, 'upload-staging', 'project-files');
const projectUpload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, cb) {
      fs.promises.mkdir(PROJECT_UPLOAD_STAGING_DIR, { recursive: true })
        .then(() => cb(null, PROJECT_UPLOAD_STAGING_DIR))
        .catch(error => cb(error, PROJECT_UPLOAD_STAGING_DIR));
    },
    filename(_req, _file, cb) { cb(null, `${Date.now()}-${uuidv4()}.upload`); },
  }),
  limits: {
    fileSize: UPLOAD_MAX_SIZE,
    fieldSize: 10 * 1024 * 1024,
    fields: 50,
    files: 500,
    parts: 1000,
  },
  fileFilter: (_req, file, cb) => {
    file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, true);
  },
});

function projectUploadFiles(req: any): Express.Multer.File[] {
  return Array.isArray(req.files) ? req.files as Express.Multer.File[] : [];
}

async function cleanupProjectUploadStaging(req: any): Promise<void> {
  const root = path.resolve(PROJECT_UPLOAD_STAGING_DIR) + path.sep;
  await Promise.all(projectUploadFiles(req)
    .filter(file => typeof file.path === 'string' && path.resolve(file.path).startsWith(root))
    .map(file => fs.promises.rm(file.path, { force: true }).catch(() => undefined)));
}

function withProjectUploadCleanup(req: any, res: any, next: (error?: unknown) => void) {
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    void cleanupProjectUploadStaging(req);
  };
  res.once('finish', cleanup);
  res.once('close', cleanup);
  next();
}

async function copyStagedProjectFile(sourcePath: string, destinationPath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
  const temporaryDestination = `${destinationPath}.tower-upload-${uuidv4()}.tmp`;
  try {
    await fs.promises.copyFile(sourcePath, temporaryDestination);
    await fs.promises.rename(temporaryDestination, destinationPath);
  } finally {
    await fs.promises.rm(temporaryDestination, { force: true }).catch(() => undefined);
  }
}

// Uploads directory for chat file attachments (saved server-side so AI can read them)
const UPLOADS_DIR = path.join(config.workspaceRoot, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Temp uploads: files land here first, move to permanent uploads/ on message send
const TEMP_UPLOADS_DIR = path.join(config.workspaceRoot, '.temp-uploads');
if (!fs.existsSync(TEMP_UPLOADS_DIR)) {
  fs.mkdirSync(TEMP_UPLOADS_DIR, { recursive: true });
}

// Startup cleanup: delete temp files older than 7 days
(function cleanupOldTempUploads() {
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  try {
    const scanDir = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
          try { if (fs.readdirSync(fullPath).length === 0) fs.rmdirSync(fullPath); } catch {}
        } else {
          try {
            const stat = fs.statSync(fullPath);
            if (now - stat.mtimeMs > SEVEN_DAYS_MS) {
              fs.unlinkSync(fullPath);
            }
          } catch {}
        }
      }
    };
    scanDir(TEMP_UPLOADS_DIR);
    console.log('[startup] cleaned up old temp uploads');
  } catch (err) {
    console.warn('[startup] temp upload cleanup error:', err);
  }
})();

const router = Router();

// ───── Backend boot ID — invalidates derivative caches on restart ─────
// Used by docx-pdf / office-pdf preview cache keys so that environment
// changes (new fonts installed, new libreoffice version, manifest update)
// take effect on the *next* PM2 restart instead of being masked by stale
// cached PDFs keyed only on filePath + mtime.
//
// 사고 동선 (2026-05-16):
//   1) demo-server 가 한글 폰트 누락으로 docx 한글 글리프 깨짐
//   2) fonts-noto-cjk + fonts-nanum 설치 + fc-cache 갱신
//   3) 같은 docx preview → *여전히 깨짐* (cache hit, 옛 PDF 그대로 서빙)
//   4) /tmp/tower-{docx,pptx}-cache/ 수동 비움 → 정상
//
// 본 ID 가 cache key 에 들어가면 backend restart 만으로 동일 효과 자동.
// 결정: workspace/decisions/2026-05-16-preview-cache-boot-id.md
const BACKEND_BOOT_ID = Date.now().toString(36);

function encodeRFC5987Value(value: string): string {
  return encodeURIComponent(value)
    .replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, '%2A');
}

function asciiFilenameFallback(fileName: string): string {
  const fallback = fileName
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/["\\\r\n]/g, '_')
    .trim();
  if (fallback && !fallback.startsWith('.')) return fallback;
  const ext = path.extname(fileName).replace(/[^A-Za-z0-9.]/g, '');
  return `download${ext}`;
}

function contentDispositionHeader(disposition: 'inline' | 'attachment', fileName: string): string {
  const fallback = asciiFilenameFallback(fileName);
  const encoded = encodeRFC5987Value(fileName);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function pdfPreviewName(filePath: string): string {
  return path.basename(filePath).replace(/\.[^.]+$/i, '.pdf');
}

async function assertReadableFileForPreview(req: any, filePath: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!filePath) return { ok: false, status: 400, error: 'path required' };
  const userId = req.user?.userId;
  const role = req.user?.role;
  const userRoot = userId ? await getUserAllowedPath(userId) : config.workspaceRoot;
  if (!isPathSafe(filePath, userRoot)) return { ok: false, status: 403, error: 'Access denied' };
  if (isDotfileDenied(filePath)) return { ok: false, status: 403, error: 'Access denied: system path' };
  if (userId && !(await isPathAccessible(filePath, userId, role))) return { ok: false, status: 403, error: 'Access denied: project path' };
  if (!fs.existsSync(filePath)) return { ok: false, status: 404, error: 'File not found' };
  return { ok: true };
}

function streamFileResponse(
  req: any,
  res: any,
  filePath: string,
  options: { contentType: string; disposition: 'inline' | 'attachment'; fileName: string; allowRange?: boolean },
) {
  const stat = fs.statSync(filePath);
  const size = stat.size;
  const rangeHeader = options.allowRange ? req.headers.range : undefined;

  res.setHeader('Content-Type', options.contentType);
  res.setHeader('Content-Disposition', contentDispositionHeader(options.disposition, options.fileName));
  res.setHeader('Accept-Ranges', 'bytes');

  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
    if (match) {
      const start = match[1] ? Number.parseInt(match[1], 10) : 0;
      const end = match[2] ? Number.parseInt(match[2], 10) : size - 1;
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < size) {
        const boundedEnd = Math.min(end, size - 1);
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${boundedEnd}/${size}`);
        res.setHeader('Content-Length', String(boundedEnd - start + 1));
        const stream = fs.createReadStream(filePath, { start, end: boundedEnd });
        stream.on('error', () => {
          if (!res.headersSent) res.status(404).json({ error: 'File not found' });
        });
        stream.pipe(res);
        return;
      }
    }
    res.status(416);
    res.setHeader('Content-Range', `bytes */${size}`);
    return res.end();
  }

  res.setHeader('Content-Length', String(size));
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) res.status(404).json({ error: 'File not found' });
  });
  stream.pipe(res);
}

const PUBLIC_BRAND_IMAGE_EXTENSIONS = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.svg', 'image/svg+xml'],
]);

function resolvePublicBrandImage(filePath: string): { path: string; contentType: string } | null {
  if (!filePath) return null;
  const resolved = path.resolve(expandHome(filePath));
  const ext = path.extname(resolved).toLowerCase();
  const contentType = PUBLIC_BRAND_IMAGE_EXTENSIONS.get(ext);
  if (!contentType) return null;
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return null;
  } catch {
    return null;
  }
  return { path: resolved, contentType };
}

function clientResetHtml(): string {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex,nofollow" />
  <title>Tower client reset</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #09090b;
      color: #e5e7eb;
    }
    main {
      width: min(520px, calc(100vw - 40px));
      padding: 28px;
      border: 1px solid rgba(148, 163, 184, 0.24);
      border-radius: 20px;
      background: rgba(15, 23, 42, 0.72);
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.32);
    }
    h1 { margin: 0 0 10px; font-size: 20px; }
    p { margin: 0 0 14px; color: #94a3b8; line-height: 1.6; }
    code { color: #fbbf24; }
    button {
      margin-top: 8px;
      padding: 10px 14px;
      border: 0;
      border-radius: 12px;
      background: #14b8a6;
      color: #042f2e;
      font-weight: 700;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <main>
    <h1>Tower 화면 캐시를 초기화하고 있습니다</h1>
    <p id="status">Service Worker와 브라우저 캐시를 지우는 중입니다…</p>
    <p>잠시 뒤 Tower를 다시 엽니다. 멈춰 있으면 아래 버튼을 눌러 주세요.</p>
    <button id="continue" type="button">Tower 다시 열기</button>
  </main>
  <script>
    (function() {
      var status = document.getElementById('status');
      var button = document.getElementById('continue');
      function setStatus(text) { if (status) status.textContent = text; }
      function safeReturnTo() {
        var params = new URLSearchParams(location.search);
        var raw = params.get('returnTo') || params.get('to') || '/';
        if (raw.charAt(0) !== '/' || raw.indexOf('//') === 0 || raw.indexOf('\\\\') !== -1) return '/';
        try {
          var url = new URL(raw, location.origin);
          if (url.origin !== location.origin) return '/';
          url.searchParams.set('__tower_client_reset', String(Date.now()));
          return url.pathname + url.search + url.hash;
        } catch (err) {
          return '/?__tower_client_reset=' + Date.now();
        }
      }
      function clearReloadGuards() {
        try {
          sessionStorage.removeItem('tower:reload-once');
          sessionStorage.removeItem('tower:reload-reason');
        } catch (err) {}
      }
      function unregisterServiceWorkers() {
        if (!('serviceWorker' in navigator)) return Promise.resolve(0);
        return navigator.serviceWorker.getRegistrations()
          .then(function(regs) {
            return Promise.all(regs.map(function(reg) { return reg.unregister(); }))
              .then(function() { return regs.length; });
          });
      }
      function clearCaches() {
        if (!('caches' in window)) return Promise.resolve(0);
        return caches.keys()
          .then(function(keys) {
            return Promise.all(keys.map(function(key) { return caches.delete(key); }))
              .then(function() { return keys.length; });
          });
      }
      function finish() {
        var target = safeReturnTo();
        setStatus('초기화가 끝났습니다. Tower를 다시 여는 중입니다…');
        location.replace(target);
      }
      if (button) button.addEventListener('click', finish);
      clearReloadGuards();
      unregisterServiceWorkers()
        .then(function(count) {
          setStatus('Service Worker ' + count + '개를 해제했습니다. 캐시를 지우는 중입니다…');
          return clearCaches();
        })
        .then(function(count) {
          setStatus('브라우저 캐시 ' + count + '개를 지웠습니다. Tower를 다시 여는 중입니다…');
          setTimeout(finish, 150);
        })
        .catch(function() {
          setStatus('자동 초기화 중 일부가 실패했습니다. Tower를 다시 열어 새 화면을 요청합니다…');
          setTimeout(finish, 300);
        });
    })();
  </script>
</body>
</html>`;
}

// ───── Public: client reset escape hatch ─────
// This route intentionally lives under /api so even stale Service Workers that
// app-shell fallback /s/<session> navigations should not intercept it. Use when
// a customer's browser is stuck on an old app shell: /api/client-reset?returnTo=/s/<key>
router.get('/client-reset', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.send(clientResetHtml());
});

// ───── Public: health ─────
// Intentionally BEFORE authMiddleware so load balancers, uptime checks,
// and fleet drift scripts can read version without a token.
router.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    ...getVersionInfo(),
    buildId: config.serverEpoch,
    publicUrl: config.publicUrl || null,
    sharePublicUrl: config.sharePublicUrl || config.publicUrl || null,
  });
});

// ───── Public: customer branding ─────
// Login is shown before auth, so the background image must be reachable publicly.
// The file path is VM-local and configured via .env, which keeps customer branding
// stable across code deploys while the bundled Tower background remains fallback.
router.get('/branding/status', (_req, res) => {
  // Optional branding must be discoverable without probing image endpoints for
  // 404s. Keep this public like the images: login renders before authentication.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.json({
    loginBackgroundConfigured: !!resolvePublicBrandImage(config.loginBackgroundImage),
    appBackgroundConfigured: !!resolvePublicBrandImage(config.appBackgroundImage),
  });
});

router.get('/branding/login-background', (_req, res) => {
  const image = resolvePublicBrandImage(config.loginBackgroundImage);
  if (!image) return res.status(404).json({ error: 'No login background configured' });

  res.setHeader('Content-Type', image.contentType);
  // VM-local branding can change without a code deploy. Do not let browser
  // cache make another VM's previous branding appear after env changes.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(image.path);
});

router.get('/branding/app-background', (_req, res) => {
  const image = resolvePublicBrandImage(config.appBackgroundImage);
  if (!image) return res.status(404).json({ error: 'No app background configured' });

  res.setHeader('Content-Type', image.contentType);
  // VM-local branding can change without a code deploy. Do not let browser
  // cache make another VM's previous branding appear after env changes.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(image.path);
});

// ───── Retired public room inbound webhook ─────
// Keep the route as an explicit compatibility response so old senders receive a
// stable terminal signal instead of retrying against an auth or 404 ambiguity.
router.post('/rooms/:id/messages', (_req, res) => {
  res.status(410).json({
    error: 'Internal channel webhooks are retired. Use an Automation trigger and Notifications instead.',
    code: 'INTERNAL_CHANNEL_RETIRED',
  });
});

// ───── Auth ─────
// Keep status/check/logout outside the aggressive auth mutation limiter. During
// invite waves, the SPA polls /auth/status before rendering the login screen; if
// that cheap read shares the same quota as login/signup, users can get trapped in
// a blank shell with no visible way to recover.
const authMutationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  message: { error: 'Too many attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const ip = req.ip || req.connection.remoteAddress || '0.0.0.0';
    return `auth:mutation:ip:${ipKeyGenerator(ip)}`;
  },
});

const authLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const ip = req.ip || req.connection.remoteAddress || '0.0.0.0';
    return `auth:login:ip:${ipKeyGenerator(ip)}`;
  },
});

router.get('/auth/status', async (_req, res) => {
  res.json({ authEnabled: config.authEnabled, hasUsers: await hasUsers() });
});

// nginx auth_request subrequest endpoint — returns 200 if valid token, 401 otherwise.
// Checks: Authorization header → query param → cookie "tower_token" → 401.
//
// Phase 2a-2 (sandbox tools auth-required): nginx's auth_request_set captures
// X-User-Id / X-Username / X-Role from the response headers and forwards them
// as X-Tower-User-Id etc. to the upstream tool container. The tool can then
// trust those headers for owner ACL checks.
// 결정: workspace/decisions/2026-05-07-execution-sandbox-q14a-nginx-mvp.md
router.get('/auth/check', (req, res) => {
  if (!config.authEnabled) return res.sendStatus(200);
  const rawToken = extractToken(req);
  if (!rawToken) return res.sendStatus(401);
  const payload = verifyToken(rawToken);
  if (!payload) return res.sendStatus(401);
  if (payload.userId) res.set('X-User-Id', String(payload.userId));
  if (payload.username) res.set('X-Username', payload.username);
  if (payload.role) res.set('X-Role', payload.role);
  res.sendStatus(200);
});

// Helper: set tower_token cookie alongside JSON response
function setTokenCookie(res: any, token: string) {
  res.cookie('tower_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 90 * 24 * 60 * 60 * 1000, // 90 days
  });
}

function clearTokenCookie(res: any) {
  res.clearCookie('tower_token', {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
  });
}

router.all('/auth/logout', (_req, res) => {
  clearTokenCookie(res);
  res.json({ ok: true });
});

router.post('/auth/setup', authMutationLimiter, async (req, res) => {
  if (await hasUsers()) return res.status(400).json({ error: 'Admin already exists' });
  const { username, password, displayName, affiliation } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  try {
    const user = await createUser(username, password, 'admin', {
      displayName: displayName ?? null,
      affiliation: affiliation ?? null,
    });
    const token = generateToken({ userId: user.id, username: user.username, role: user.role });
    setTokenCookie(res, token);
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (err: any) {
    if (err instanceof InvalidUsernameError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }
});

router.post('/auth/signup', authMutationLimiter, async (req, res) => {
  const { inviteCode, username, password, displayName, affiliation } = req.body ?? {};
  if (!inviteCode || !username || !password || !displayName) {
    return res.status(400).json({ error: 'inviteCode, username, password, and displayName are required' });
  }
  try {
    const approvalMode = await getSignupApprovalMode();
    const user = await requestSignup({ inviteCode, username, password, displayName, affiliation, approvalMode });

    // Admins should know immediately who tries to enter the workspace.
    // Notification failure must not block signup.
    try {
      const admins = await query<{ id: number }>(
        `SELECT id FROM users WHERE disabled = 0 AND role = 'admin' AND id <> $1`,
        [user.id],
      );
      const adminIds = admins.map((row) => row.id);
      if (adminIds.length > 0) {
        const { notifyMany } = await import('../services/notification-hub.js');
        await notifyMany(
          adminIds,
          null,
          'system.announcement',
          approvalMode === 'manual' ? '새 가입 승인이 필요합니다' : '새 사용자가 가입했습니다',
          approvalMode === 'manual'
            ? `${displayName} (${user.username}) 님이 초대 코드로 가입 신청했습니다.`
            : `${displayName} (${user.username}) 님이 초대 코드로 가입했습니다.`,
          {
            event: 'signup.completed',
            userId: user.id,
            username: user.username,
            displayName,
            affiliation: affiliation || null,
            inviteCode,
            approvalMode,
            approvalStatus: user.approval_status,
          },
          { priority: 'normal', actionUrl: '/', defaultChannels: ['in_app', 'toast'] },
        );
      }
    } catch (notifyErr) {
      console.warn('[auth/signup] failed to notify admins:', notifyErr);
    }

    res.json({ ok: true, user, approvalMode });
  } catch (err: any) {
    if (err instanceof InvalidInviteCodeError) return res.status(400).json({ error: err.message });
    if (err instanceof InvalidUsernameError) return res.status(400).json({ error: err.message });
    if (err instanceof UsernameTakenError) return res.status(409).json({ error: err.message });
    if (err.message?.includes('duplicate key')) return res.status(409).json({ error: 'Username already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.post('/auth/login', authLoginLimiter, async (req, res) => {
  const { username, password } = req.body;
  const result = await authenticateUser(username, password);
  if (!result.ok || !result.payload) {
    if (result.reason === 'pending_approval') return res.status(403).json({ error: 'Account is pending admin approval' });
    if (result.reason === 'rejected') return res.status(403).json({ error: 'Account was rejected by an admin' });
    if (result.reason === 'suspended') return res.status(403).json({ error: 'Account is suspended' });
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = generateToken(result.payload);
  setTokenCookie(res, token);
  res.json({ token, user: result.payload });
});

router.post('/auth/cli-login', authLoginLimiter, async (req, res) => {
  const { username, password } = req.body;
  const result = await authenticateUser(username, password);
  if (!result.ok || !result.payload) {
    if (result.reason === 'pending_approval') return res.status(403).json({ error: 'Account is pending admin approval' });
    if (result.reason === 'rejected') return res.status(403).json({ error: 'Account was rejected by an admin' });
    if (result.reason === 'suspended') return res.status(403).json({ error: 'Account is suspended' });
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = generateScopedToken(result.payload, { aud: 'tower-cli', expiresIn: '30d' });
  res.json({ token, user: { ...result.payload, aud: 'tower-cli' } });
});

// Kakao OAuth 라우트는 #58 Phase 3 에서 제거됨 (외부 메시징 폐기).

// ───── Google OAuth ─────

function googleOAuthStateForAgent(user: { userId: number; username: string; role: string }, projectId: string, credentialId: string): string {
  // Never forward claims such as exp/iat from the normal Tower session token.
  // The short-lived state binds the callback to one authenticated user, Agent,
  // and Credential ID so reauthentication cannot silently rotate another account.
  const statePrincipal = {
    userId: user.userId,
    username: user.username,
    role: user.role,
    projectId,
    credentialId,
    connectionScope: 'agent' as const,
  };
  return generateScopedToken(statePrincipal, { aud: 'google-agent-oauth-state', expiresIn: '10m' });
}

function googleOAuthStateForOrganization(user: { userId: number; username: string; role: string }, credentialId: string, connectionMode: 'create' | 'reauth'): string {
  return generateScopedToken({
    userId: user.userId,
    username: user.username,
    role: user.role,
    credentialId,
    connectionScope: 'organization',
    connectionMode,
  }, { aud: 'google-organization-oauth-state', expiresIn: '10m' });
}

function agentGwsCredentialId(projectId: string): string {
  const projectPart = projectId.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 52);
  return `gws-agent-${projectPart}`;
}

async function assertAgentGoogleConnectionAccess(user: { userId: number; role: string }, projectId: string): Promise<boolean> {
  if (isPrivilegedRole(user.role)) return true;
  if (user.role === 'viewer' || user.role === 'guest') return false;
  return isProjectMember(projectId, user.userId);
}

router.get('/auth/google/agent', authMiddleware, async (req, res) => {
  if (!isGoogleOAuthConfigured()) return res.status(503).json({ error: 'Google OAuth is not configured on this Tower server' });
  const user = (req as any).user;
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId.trim() : '';
  const requestedCredentialId = typeof req.query.credentialId === 'string' ? req.query.credentialId.trim() : '';
  if (!projectId) return res.status(400).json({ error: 'projectId required' });
  if (!(await assertAgentGoogleConnectionAccess(user, projectId))) return res.status(403).json({ error: 'Agent Connection management requires member access' });
  const project = await queryOne<{ id: string }>('SELECT id FROM projects WHERE id = $1', [projectId]);
  if (!project) return res.status(404).json({ error: 'Agent not found' });

  const credentialId = requestedCredentialId || agentGwsCredentialId(projectId);
  if (!/^[a-z0-9][a-z0-9_-]{1,79}$/.test(credentialId)) return res.status(400).json({ error: 'invalid credentialId' });
  if (requestedCredentialId) {
    const owned = await queryOne<{ id: string }>(
      `SELECT id FROM workspace_credentials
        WHERE id = $1 AND kind = 'gws' AND provider = 'google' AND scope = 'project'
          AND metadata->>'connection_type' = 'agent'
          AND metadata->>'agent_project_id' = $2`,
      [credentialId, projectId],
    );
    if (!owned) return res.status(404).json({ error: 'Agent Google Connection not found' });
  }
  const url = getGoogleAuthUrl(googleOAuthStateForAgent(user, projectId, credentialId));
  res.json({ url, credentialId });
});

router.get('/auth/google/organization', authMiddleware, async (req, res) => {
  if (!isGoogleOAuthConfigured()) return res.status(503).json({ error: 'Google OAuth is not configured on this Tower server' });
  const user = (req as any).user;
  if (user?.role !== 'admin') return res.status(403).json({ error: 'Admin required' });
  const requestedCredentialId = typeof req.query.credentialId === 'string' ? req.query.credentialId.trim() : '';
  const mode = req.query.mode === 'reauth' ? 'reauth' : req.query.mode === 'create' ? 'create' : null;
  if (!mode) return res.status(400).json({ error: 'mode must be create or reauth' });
  const credentialId = requestedCredentialId || `gws-organization-${Date.now().toString(36)}`;
  if (!/^[a-z0-9][a-z0-9_-]{1,79}$/.test(credentialId)) return res.status(400).json({ error: 'invalid credentialId' });
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM workspace_credentials
      WHERE id = $1 AND kind = 'gws' AND provider = 'google' AND scope = 'workspace'`,
    [credentialId],
  );
  if (mode === 'reauth' && !existing) return res.status(404).json({ error: 'Organization Google Connection not found' });
  if (mode === 'create' && existing) return res.status(409).json({ error: 'Organization Google Connection ID already exists' });
  const url = getGoogleAuthUrl(googleOAuthStateForOrganization(user, credentialId, mode));
  res.json({ url, credentialId });
});

router.get('/auth/google/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('Missing authorization code');

    // Verify user from state (which is the JWT token)
    const payload = state ? verifyToken(state as string) : null;
    const isAgentFlow = payload?.aud === 'google-agent-oauth-state' && payload.connectionScope === 'agent' && payload.projectId && payload.credentialId;
    const isOrganizationFlow = payload?.aud === 'google-organization-oauth-state' && payload.connectionScope === 'organization' && payload.credentialId;
    const oauthResultType = isOrganizationFlow ? 'google-organization' : 'google-agent';
    if (!payload || (!isAgentFlow && !isOrganizationFlow)) {
      const baseUrl = config.publicUrl || `${req.protocol}://${req.get('host')}`;
      return res.redirect(`${baseUrl}/?oauth=${oauthResultType}&status=error&message=invalid_or_expired_state`);
    }
    if (isAgentFlow && !(await assertAgentGoogleConnectionAccess(payload, payload.projectId!))) {
      const baseUrl = config.publicUrl || `${req.protocol}://${req.get('host')}`;
      return res.redirect(`${baseUrl}/?oauth=google-agent&status=error&message=agent_access_denied`);
    }
    if (isOrganizationFlow) {
      const currentUser = await queryOne<{ role: string; disabled: number | boolean }>('SELECT role, disabled FROM users WHERE id = $1', [payload.userId]);
      if (payload.role !== 'admin' || currentUser?.role !== 'admin' || Boolean(currentUser.disabled)) {
        const baseUrl = config.publicUrl || `${req.protocol}://${req.get('host')}`;
        return res.redirect(`${baseUrl}/?oauth=google-organization&status=error&message=admin_required`);
      }
      if (payload.connectionMode === 'create') {
        const collision = await queryOne<{ id: string }>('SELECT id FROM workspace_credentials WHERE id = $1', [payload.credentialId]);
        if (collision) {
          const baseUrl = config.publicUrl || `${req.protocol}://${req.get('host')}`;
          return res.redirect(`${baseUrl}/?oauth=google-organization&status=error&message=connection_id_already_exists`);
        }
      } else if (payload.connectionMode === 'reauth') {
        const target = await queryOne<{ id: string }>(
          `SELECT id FROM workspace_credentials WHERE id = $1 AND kind = 'gws' AND provider = 'google' AND scope = 'workspace'`,
          [payload.credentialId],
        );
        if (!target) {
          const baseUrl = config.publicUrl || `${req.protocol}://${req.get('host')}`;
          return res.redirect(`${baseUrl}/?oauth=google-organization&status=error&message=organization_connection_not_found`);
        }
      } else {
        const baseUrl = config.publicUrl || `${req.protocol}://${req.get('host')}`;
        return res.redirect(`${baseUrl}/?oauth=google-organization&status=error&message=invalid_connection_mode`);
      }
    }

    // Exchange code for tokens
    const tokens = await exchangeGoogleCode(code as string);

    // Get Google user info (email, name)
    const userInfo = await getGoogleUserInfo(tokens.accessToken);

    const encodedConfig = await buildAgentGwsConfigBundle({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? '',
      scopes: GOOGLE_DEFAULT_SCOPES,
    });
    const secretPrefix = isOrganizationFlow ? 'GWS_ORGANIZATION' : 'GWS_AGENT';
    const secretName = `${secretPrefix}_${payload.credentialId!.toUpperCase().replace(/[^A-Z0-9_]+/g, '_')}_CONFIG_B64`.slice(0, 64);
    if (isOrganizationFlow) {
      await upsertOrganizationGwsCredential({
        credentialId: payload.credentialId!,
        displayName: userInfo.email ? `조직 Google Workspace · ${userInfo.email}` : '조직 Google Workspace',
        secretName,
        encodedConfig,
        googleAccount: userInfo.email,
        actorUserId: payload.userId,
      });
    } else {
      await upsertAgentGwsCredential({
        projectId: payload.projectId!,
        credentialId: payload.credentialId!,
        displayName: userInfo.email ? `Google Workspace · ${userInfo.email}` : 'Google Workspace',
        secretName,
        encodedConfig,
        googleAccount: userInfo.email,
        actorUserId: payload.userId,
      });
    }

    const baseUrl = config.publicUrl || `${req.protocol}://${req.get('host')}`;
    const projectQuery = isAgentFlow ? `&projectId=${encodeURIComponent(payload.projectId!)}` : '';
    res.redirect(`${baseUrl}/?oauth=${oauthResultType}&status=success${projectQuery}&credentialId=${encodeURIComponent(payload.credentialId!)}`);
  } catch (err: any) {
    console.error('[Google OAuth] Error:', err.message);
    const baseUrl = config.publicUrl || `${req.protocol}://${req.get('host')}`;
    const statePayload = typeof req.query.state === 'string' ? verifyToken(req.query.state) : null;
    const errorTarget = statePayload?.aud === 'google-organization-oauth-state' ? 'google-organization' : 'google-agent';
    res.redirect(`${baseUrl}/?oauth=${errorTarget}&status=error&message=oauth_callback_failed`);
  }
});

// Telegram Bot Linking / webhook 라우트는 #58 Phase 3 에서 제거됨 (외부 메시징 폐기).

// User-facing OAuth provider catalog + connection status. The catalog is
// provider-agnostic so Credential Vault can add future OAuth account types
// without hard-coding cards in the frontend.
router.get('/auth/oauth/providers', authMiddleware, async (req, res) => {
  const user = (req as any).user;
  const providers = await Promise.all(listOAuthProviders().map(async provider => {
    const token = await oauthManager.getToken(user.userId, provider.id);
    let status: 'connected' | 'reauth_required' | 'not_connected' = token ? 'connected' : 'not_connected';
    let statusReason: string | undefined;

    if (token) {
      try {
        // This validates the access token lifecycle without exposing token data.
        // Expired access tokens are refreshed and persisted by oauthManager.
        await oauthManager.getValidToken(user.userId, provider.id);
      } catch (err) {
        status = 'reauth_required';
        statusReason = err instanceof Error ? err.message : 'OAuth token validation failed';
      }
    }

    return {
      ...provider,
      connected: status === 'connected',
      status,
      statusReason,
      nickname: token?.provider_nickname || undefined,
      tokenExpiresAt: token?.token_expires_at || undefined,
      hasRefreshToken: Boolean(token?.refresh_token),
    };
  }));
  res.json({ providers });
});

// Legacy status shape retained for the Settings panel and older clients.
router.get('/auth/oauth/status', authMiddleware, async (req, res) => {
  const user = (req as any).user;
  const details: Record<string, { connected: boolean; nickname?: string }> = {};

  for (const provider of listOAuthProviders()) {
    const token = await oauthManager.getToken(user.userId, provider.id);
    details[provider.id] = {
      connected: !!token,
      nickname: token?.provider_nickname || undefined,
    };
  }
  res.json(details);
});

// Disconnect OAuth provider. Removing Google also removes the personal GWS
// config bundle so Runtime Box cannot silently keep using stale credentials.
router.delete('/auth/oauth/:provider', authMiddleware, async (req, res) => {
  const user = (req as any).user;
  const providerId = req.params.provider as string;
  const provider = findOAuthProvider(providerId);
  if (!provider) return res.status(404).json({ error: 'Unsupported OAuth provider' });

  await oauthManager.deleteToken(user.userId, providerId);
  if (providerId === 'google') {
    await execute(
      `DELETE FROM secret_store
       WHERE name = $1 AND scope = 'user' AND owner_user_id = $2`,
      [GWS_PERSONAL_CONFIG_SECRET_NAME, user.userId],
    );
  }
  res.json({ ok: true });
});

// 외부 메시징 테스트 라우트(/auth/oauth/:provider/test)는 #58 Phase 3 에서 제거됨.

// ───── Skill Credential Binding ─────

import {
  getUserConnections,
  getUserSkillReadiness,
  checkSkillReadiness,
  getSkillProviders,
  setSkillProviders,
  PROVIDER_META,
} from '../services/skill/skill-credential.js';

// My connections overview (all providers + connection status)
router.get('/me/connections', authMiddleware, async (req, res) => {
  const user = (req as any).user;
  const connections = await getUserConnections(user.userId);
  res.json(connections);
});

// My skill readiness (which skills I can/can't use due to missing credentials)
router.get('/me/skill-readiness', authMiddleware, async (req, res) => {
  const user = (req as any).user;
  const readiness = await getUserSkillReadiness(user.userId);
  res.json(readiness);
});

// 2026-04-17: skill_providers/user_skill_prefs는 skill_name 기반.
// :id 파라미터는 UUID(personal/project) 또는 name(library/company) 어느 쪽도 가능하므로
// 먼저 getSkill()으로 조회해 정식 name을 뽑아서 credential 함수에 넘긴다.
async function resolveSkillName(idOrName: string): Promise<string | null> {
  const s = await getSkill(idOrName);
  return s?.name ?? null;
}

// Check readiness for a specific skill
router.get('/skills/:id/readiness', authMiddleware, async (req, res) => {
  const user = (req as any).user;
  const skill = await getSkill(req.params.id as string);
  if (!skill) return res.status(404).json({ error: 'Skill not found' });
  const name = skill.name;
  const readiness = await checkSkillReadiness(name, user.userId, skill.content);
  res.json(readiness);
});

// Get providers required by a skill
router.get('/skills/:id/providers', authMiddleware, async (req, res) => {
  const name = await resolveSkillName(req.params.id as string);
  if (!name) return res.status(404).json({ error: 'Skill not found' });
  const providers = await getSkillProviders(name);
  res.json(providers);
});

// Set providers for a skill (admin only)
router.put('/skills/:id/providers', authMiddleware, async (req, res) => {
  const user = (req as any).user;
  if (user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const name = await resolveSkillName(req.params.id as string);
  if (!name) return res.status(404).json({ error: 'Skill not found' });
  await setSkillProviders(name, req.body.providers ?? []);
  res.json({ ok: true });
});

// Available provider types (for UI dropdowns)
router.get('/providers', authMiddleware, (_req, res) => {
  res.json(PROVIDER_META);
});

// ───── Public: Shared file viewer (no auth required) ─────
const MIME_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
};

router.get('/shared/:token', async (req, res) => {
  const token = req.params.token as string;
  const accept = String(req.headers.accept || '');
  if (!req.query.render && !req.query.download && accept.includes('text/html') && !accept.includes('application/json')) {
    return res.redirect(302, `/shared/${encodeURIComponent(token)}`);
  }

  const share = await getShareByToken(token);
  if (!share || !isTokenValid(share)) {
    return res.status(410).json({ error: 'This link has expired or been revoked.' });
  }
  try {
    const fileName = path.basename(share.file_path);
    const ext = path.extname(fileName).slice(1).toLowerCase();

    // ?render=1 — 브라우저가 직접 렌더링할 수 있도록 Content-Type과 함께 파일 그대로 전송.
    // HTML은 legacy Korean encodings(cp949/euc-kr 등)로 저장된 파일이 많아서
    // charset=utf-8 헤더만 붙여 원본 바이트를 보내면 외부 공유 iframe에서 글자가 깨진다.
    // 공유 뷰어가 UTF-8로 안정적으로 표시되도록 텍스트로 디코딩 후 전송한다.
    if (req.query.render === '1') {
      if (ext === 'html' || ext === 'htm') {
        const buffer = await fsPromises.readFile(share.file_path);
        const { content } = decodeTextBuffer(buffer);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(content);
      }
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      const buffer = await fsPromises.readFile(share.file_path);
      return res.send(buffer);
    }

    // ?download=1 — 파일 다운로드
    if (req.query.download === '1') {
      res.setHeader('Content-Disposition', contentDispositionHeader('attachment', fileName));
      res.setHeader('Content-Type', 'application/octet-stream');
      const buffer = await fsPromises.readFile(share.file_path);
      return res.send(buffer);
    }

    // 기본 — JSON으로 콘텐츠 반환
    // 바이너리 파일(PDF, 이미지, 영상)은 utf-8 읽기 불가 → 메타데이터만 반환 (프론트에서 iframe으로 렌더링)
    const BINARY_EXTS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'mp4', 'm4v', 'mov', 'webm']);
    if (BINARY_EXTS.has(ext)) {
      return res.json({ content: '', fileName, ext });
    }
    const buffer = await fsPromises.readFile(share.file_path);
    const { content, charset } = decodeTextBuffer(buffer);
    res.json({ content, fileName, ext, encoding: charset });
  } catch {
    return res.status(404).json({ error: 'File not found.' });
  }
});

// ───── Shared Session (public, no auth) ─────
/**
 * Detect whether the requesting client is an AI fetcher / LLM-driven crawler.
 * AI clients get a clean markdown response by default — far smaller token footprint
 * than the full HTML page (which loads mermaid/highlight.js/chart.js + ~200 lines CSS).
 * Browsers (Mozilla UA) and social preview bots (Slackbot/Twitterbot/Discordbot/etc.)
 * still get the rich HTML version. Explicit `?format=md|json|html` always overrides.
 */
function prefersMarkdown(req: any): boolean {
  const ua: string = (req.headers['user-agent'] || '').toString();
  if (!ua) return false;
  return /GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|Claude-User|Claude-Web|Anthropic-AI|PerplexityBot|YouBot|Cohere-AI|Google-Extended|Bytespider|CCBot/i.test(ua);
}

router.get('/shared-session/:token', async (req, res) => {
  const formatParam = String(req.query.format || '').toLowerCase();
  const wantsJson = formatParam === 'json';
  const wantsMd = formatParam === 'md' || formatParam === 'markdown' || (formatParam !== 'html' && prefersMarkdown(req));

  const share = await getSessionShareByToken(req.params.token as string);
  if (!share || !isSessionShareValid(share)) {
    const expired = !share ? 'not found' : 'expired';
    if (wantsJson) {
      return res.status(410).json({ error: 'This link has expired or been revoked.' });
    }
    if (wantsMd) {
      const msg = expired === 'not found' ? '존재하지 않는 공유 링크입니다.' : '이 공유 링크는 만료되었거나 취소되었습니다.';
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      return res.status(410).send(`# 공유 세션\n\n> ${msg}\n`);
    }
    return res.status(410).send(renderSharedSessionError(expired));
  }
  try {
    const snapshot: any[] = share.snapshot_json ? JSON.parse(share.snapshot_json) : [];
    const session = await queryOne('SELECT name FROM sessions WHERE id = $1', [share.session_id]);
    const sessionName = (session as any)?.name ?? 'Shared Session';

    // JSON format (for programmatic access)
    if (wantsJson) {
      return res.json({ sessionName, messages: snapshot, sharedAt: share.created_at, expiresAt: share.expires_at });
    }

    // Markdown — explicit ?format=md OR known AI fetcher User-Agent.
    // Plain text, no JS/CSS overhead → AI parses ~10x faster than the HTML page.
    if (wantsMd) {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      return res.send(renderSharedSessionMarkdown(sessionName, snapshot, share.created_at, share.expires_at));
    }

    // Default: render as readable HTML document
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderSharedSessionHtml(sessionName, snapshot, share.created_at, share.expires_at));
  } catch {
    return res.status(500).send(renderSharedSessionError('error'));
  }
});

/** Extract text from message content (string, JSON string, or ContentBlock array) */
function extractMessageText(content: any): string {
  // Already an array of blocks
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === 'text' && b.text)
      .map((b: any) => b.text)
      .join('\n\n');
  }
  if (typeof content !== 'string') return '';
  // Try to parse as JSON (double-serialized content blocks)
  const trimmed = content.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((b: any) => b.type === 'text' && b.text)
          .map((b: any) => b.text)
          .join('\n\n');
      }
    } catch { /* not JSON, treat as plain text */ }
  }
  return content;
}

/** Minimal HTML escape */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Merge consecutive same-role messages and drop empties */
function collapseMessages(messages: any[]): { role: string; text: string; username?: string }[] {
  const result: { role: string; text: string; username?: string }[] = [];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const text = extractMessageText(m.content).trim();
    if (!text) continue;
    const last = result[result.length - 1];
    if (last && last.role === m.role) {
      // Merge consecutive same-role messages
      last.text += '\n\n' + text;
    } else {
      result.push({ role: m.role, text, username: m.username });
    }
  }
  return result;
}

/**
 * Convert markdown text to HTML with rich block support.
 * Handles: mermaid, chart, datatable, timeline, code blocks with syntax highlight,
 * headers, lists, bold, inline code, horizontal rules, tables.
 */
function mdToHtml(text: string): string {
  // First, split by code blocks to handle them separately
  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    const cbMatch = remaining.match(/```(\w*)\n([\s\S]*?)```/);
    if (!cbMatch || cbMatch.index === undefined) {
      parts.push(renderMarkdownInline(remaining));
      break;
    }
    // Text before the code block
    if (cbMatch.index > 0) {
      parts.push(renderMarkdownInline(remaining.slice(0, cbMatch.index)));
    }
    const lang = cbMatch[1].toLowerCase();
    const code = cbMatch[2];

    if (lang === 'mermaid') {
      // Mermaid needs raw text — esc() would break --> into --&gt;
      parts.push(`<div class="mermaid">${code}</div>`);
    } else if (lang === 'chart') {
      parts.push(renderChartBlock(code));
    } else if (lang === 'datatable') {
      parts.push(renderDatatableBlock(code));
    } else if (lang === 'timeline') {
      parts.push(renderTimelineBlock(code));
    } else {
      // Regular code block with syntax highlighting
      parts.push(`<pre><code class="${lang ? `language-${esc(lang)}` : ''}">${esc(code)}</code></pre>`);
    }

    remaining = remaining.slice(cbMatch.index + cbMatch[0].length);
  }

  return parts.join('');
}

/** Apply inline formatting (bold, code, links) to already-escaped text */
function inlineFmt(text: string): string {
  let s = esc(text);
  // Links [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Bold
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Inline code
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  return s;
}

/** Render inline markdown (everything except code blocks) — line-by-line, no nesting block in p */
function renderMarkdownInline(text: string): string {
  const lines = text.split('\n');
  const blocks: string[] = [];
  let paraLines: string[] = [];
  let listLines: string[] = [];
  let listType: 'ul' | 'ol' | '' = '';
  let tableLines: string[] = [];

  const flushPara = () => {
    if (paraLines.length === 0) return;
    const content = paraLines.join('<br>');
    if (content.trim()) blocks.push(`<p>${inlineFmt(content)}</p>`);
    paraLines = [];
  };
  const flushList = () => {
    if (listLines.length === 0) return;
    const tag = listType || 'ul';
    blocks.push(`<${tag}>${listLines.map(l => `<li>${inlineFmt(l)}</li>`).join('')}</${tag}>`);
    listLines = [];
    listType = '';
  };
  const flushTable = () => {
    if (tableLines.length < 2) { tableLines = []; return; }
    const rows = tableLines.filter(r => r.trim());
    const dataRows = rows.filter(r => !/^\|[\s\-:|]+\|$/.test(r));
    if (dataRows.length === 0) { tableLines = []; return; }
    const parseRow = (r: string) => r.split('|').slice(1, -1).map(c => c.trim());
    const headerCells = parseRow(dataRows[0]);
    const bodyRows = dataRows.slice(1);
    let table = '<div class="table-wrap"><table><thead><tr>';
    headerCells.forEach(c => { table += `<th>${inlineFmt(c)}</th>`; });
    table += '</tr></thead><tbody>';
    bodyRows.forEach(r => {
      const cells = parseRow(r);
      table += '<tr>';
      cells.forEach(c => { table += `<td>${inlineFmt(c)}</td>`; });
      table += '</tr>';
    });
    table += '</tbody></table></div>';
    blocks.push(table);
    tableLines = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // Table rows (| col | col |)
    if (/^\|.+\|$/.test(trimmed)) {
      flushPara();
      flushList();
      tableLines.push(trimmed);
      continue;
    }
    if (tableLines.length > 0) flushTable();

    // Horizontal rule
    if (/^---+$/.test(trimmed)) {
      flushPara(); flushList();
      blocks.push('<hr>');
      continue;
    }

    // Headers
    const hMatch = trimmed.match(/^(#{1,5})\s+(.+)$/);
    if (hMatch) {
      flushPara(); flushList();
      const level = Math.min(hMatch[1].length + 1, 6); // # → h2, ## → h3, etc.
      blocks.push(`<h${level}>${inlineFmt(hMatch[2])}</h${level}>`);
      continue;
    }

    // Bullet list
    const bulletMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (bulletMatch) {
      flushPara();
      if (listType === 'ol') flushList();
      listType = 'ul';
      listLines.push(bulletMatch[1]);
      continue;
    }

    // Numbered list
    const numMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (numMatch) {
      flushPara();
      if (listType === 'ul') flushList();
      listType = 'ol';
      listLines.push(numMatch[1]);
      continue;
    }

    // Non-list line ends any list
    if (listLines.length > 0) flushList();

    // Empty line = paragraph break
    if (!trimmed) {
      flushPara();
      continue;
    }

    // Regular text line → accumulate into paragraph
    paraLines.push(line);
  }

  // Flush remaining
  if (tableLines.length > 0) flushTable();
  flushList();
  flushPara();

  return blocks.join('\n');
}

/** Render ```chart block as a canvas chart */
function renderChartBlock(jsonStr: string): string {
  try {
    const config = JSON.parse(jsonStr);
    const id = `chart-${Math.random().toString(36).slice(2, 8)}`;
    // Pass config as data attribute for client-side rendering
    return `<div class="dynamic-chart"><canvas id="${id}" data-chart='${esc(JSON.stringify(config))}'></canvas></div>`;
  } catch {
    return `<pre><code>${esc(jsonStr)}</code></pre>`;
  }
}

/** Render ```datatable block as an HTML table */
function renderDatatableBlock(jsonStr: string): string {
  try {
    const config = JSON.parse(jsonStr);
    const cols: string[] = config.columns || [];
    const rows: any[][] = config.data || [];
    let html = '<div class="table-wrap"><table><thead><tr>';
    cols.forEach((c: string) => { html += `<th>${esc(String(c))}</th>`; });
    html += '</tr></thead><tbody>';
    rows.forEach((row: any[]) => {
      html += '<tr>';
      row.forEach((cell: any) => { html += `<td>${esc(String(cell ?? ''))}</td>`; });
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    return html;
  } catch {
    return `<pre><code>${esc(jsonStr)}</code></pre>`;
  }
}

/** Render ```timeline block */
function renderTimelineBlock(jsonStr: string): string {
  try {
    const config = JSON.parse(jsonStr);
    const items: any[] = config.items || [];
    let html = '<div class="timeline">';
    items.forEach((item: any) => {
      const statusClass = item.status === 'done' ? 'tl-done' : item.status === 'in-progress' ? 'tl-active' : 'tl-pending';
      html += `<div class="tl-item ${statusClass}">`;
      html += `<div class="tl-dot"></div>`;
      html += `<div class="tl-content">`;
      html += `<div class="tl-date">${esc(String(item.date || ''))}</div>`;
      html += `<div class="tl-title">${esc(String(item.title || ''))}</div>`;
      if (item.description) html += `<div class="tl-desc">${esc(String(item.description))}</div>`;
      html += `</div></div>`;
    });
    html += '</div>';
    return html;
  } catch {
    return `<pre><code>${esc(jsonStr)}</code></pre>`;
  }
}

/**
 * Render shared session as plain markdown — for AI fetchers / `?format=md`.
 * Owns: AI-friendly transcript output. Public API: returns string body for `text/markdown`.
 * Same source-of-truth (collapseMessages) as the HTML version, just stripped to text.
 */
function renderSharedSessionMarkdown(title: string, messages: any[], sharedAt: string, expiresAt?: string): string {
  const fmt = (iso: string) => new Date(iso).toLocaleString('ko-KR', {
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const sharedLine = `공유 시각 ${fmt(sharedAt)}`;
  const expiresLine = expiresAt ? ` · 만료 ${fmt(expiresAt)}` : '';

  const collapsed = collapseMessages(messages);
  const body = collapsed.map((m) => {
    const label = m.role === 'user'
      ? `User${m.username ? ` (${m.username})` : ''}`
      : 'AI';
    return `## ${label}\n\n${m.text.trim()}`;
  }).join('\n\n---\n\n');

  return `# ${title}\n\n> Tower 세션 공유 · ${sharedLine}${expiresLine}\n\n---\n\n${body || '_(내용 없음)_'}\n`;
}

/** Render shared session as a readable HTML document */
function renderSharedSessionHtml(title: string, messages: any[], sharedAt: string, expiresAt?: string): string {
  const sharedDate = new Date(sharedAt).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const expiresDate = expiresAt ? new Date(expiresAt).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

  const collapsed = collapseMessages(messages);
  const messagesHtml = collapsed
    .map((m) => {
      const isUser = m.role === 'user';
      const label = isUser ? (m.username || 'User') : 'AI';
      const labelClass = isUser ? 'msg-user' : 'msg-ai';
      const initial = isUser ? label.charAt(0).toUpperCase() : 'AI';
      return `<div class="msg ${labelClass}"><div class="msg-label"><span class="avatar">${esc(initial)}</span>${esc(label)}</div><div class="msg-body">${mdToHtml(m.text)}</div></div>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Tower</title>
<!-- Mermaid for diagrams -->
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"><\/script>
<!-- Highlight.js for code syntax highlighting -->
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11/styles/github.min.css">
<script src="https://cdn.jsdelivr.net/npm/highlight.js@11/lib/core.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/highlight.js@11/lib/languages/javascript.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/highlight.js@11/lib/languages/typescript.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/highlight.js@11/lib/languages/python.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/highlight.js@11/lib/languages/bash.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/highlight.js@11/lib/languages/json.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/highlight.js@11/lib/languages/sql.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/highlight.js@11/lib/languages/css.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/highlight.js@11/lib/languages/xml.min.js"><\/script>
<!-- Chart.js for charts -->
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"><\/script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { scrollbar-gutter: stable; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f0f2f5; color: #1a1a1a; line-height: 1.7; }
  .container { max-width: 780px; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
  /* Header */
  .header { background: #fff; border-radius: 16px; padding: 1.25rem 1.5rem; margin-bottom: 1rem; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
  .header h1 { font-size: 1.1rem; color: #1a1a1a; font-weight: 600; margin-bottom: 0.3rem; }
  .header .meta { font-size: 0.72rem; color: #8b8b8b; display: flex; gap: 0.75rem; flex-wrap: wrap; align-items: center; }
  .badge { display: inline-block; font-size: 0.6rem; background: #e8f4fd; color: #2d7dd2; padding: 0.2em 0.6em; border-radius: 10px; font-weight: 500; }
  /* Chat thread */
  .chat-thread { display: flex; flex-direction: column; gap: 0.5rem; }
  /* Messages — chat bubble style */
  .msg { display: flex; flex-direction: column; min-width: 0; }
  .msg-user { align-self: flex-end; align-items: flex-end; width: min(85%, max-content); max-width: 85%; }
  .msg-ai { align-self: flex-start; align-items: flex-start; width: 100%; }
  .msg-label { font-size: 0.65rem; font-weight: 600; letter-spacing: 0.02em; margin-bottom: 0.2rem; padding: 0 0.5rem; display: flex; align-items: center; gap: 0.35rem; }
  .msg-user .msg-label { color: #2d7dd2; }
  .msg-ai .msg-label { color: #7c3aed; }
  .msg-label .avatar { width: 18px; height: 18px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 0.55rem; font-weight: 700; color: #fff; }
  .msg-user .avatar { background: #2d7dd2; }
  .msg-ai .avatar { background: #7c3aed; }
  .msg-body { font-size: 0.88rem; color: #1a1a1a; padding: 0.85rem 1.1rem; border-radius: 18px; line-height: 1.65; max-width: 100%; min-width: 0; overflow-wrap: anywhere; }
  .msg-ai .msg-body { width: 100%; }
  .msg-user .msg-body { background: #2d7dd2; color: #fff; border-bottom-right-radius: 6px; }
  .msg-user .msg-body strong { color: #fff; }
  .msg-user .msg-body code { background: rgba(255,255,255,0.2); color: #fff; }
  .msg-ai .msg-body { background: #fff; border-bottom-left-radius: 6px; box-shadow: 0 1px 2px rgba(0,0,0,0.05); }
  .msg-body p { margin-bottom: 0.5rem; }
  .msg-body p:last-child { margin-bottom: 0; }
  .msg-body p:empty { display: none; }
  /* Typography */
  .msg-body h2 { font-size: 1.05rem; color: #111; font-weight: 700; margin: 1.2rem 0 0.4rem; }
  .msg-body h3 { font-size: 0.95rem; color: #111; font-weight: 700; margin: 1rem 0 0.35rem; }
  .msg-body h4 { font-size: 0.88rem; color: #333; font-weight: 600; margin: 0.8rem 0 0.25rem; }
  .msg-body h5 { font-size: 0.82rem; color: #444; font-weight: 600; margin: 0.6rem 0 0.2rem; }
  .msg-body ul, .msg-body ol { padding-left: 1.4rem; margin: 0.4rem 0; }
  .msg-body li { margin-bottom: 0.2rem; }
  .msg-body hr { border: none; border-top: 1px solid #e5e7eb; margin: 1rem 0; }
  .msg-body a { color: #2d7dd2; text-decoration: underline; }
  .msg-user .msg-body a { color: #bfdbfe; }
  strong { color: #111; }
  .msg-user strong { color: #fff; }
  .msg-body > * { max-width: 100%; }
  /* Code */
  pre { background: #f6f8fa; border: 1px solid #e1e4e8; border-radius: 10px; padding: 0.85rem 1rem; overflow-x: auto; margin: 0.6rem 0; font-size: 0.78rem; line-height: 1.55; }
  .msg-user pre { background: rgba(255,255,255,0.15); border-color: rgba(255,255,255,0.2); color: #fff; }
  pre code { background: none; padding: 0; border-radius: 0; font-size: inherit; color: inherit; }
  code { font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace; font-size: 0.84em; }
  :not(pre) > code { background: #eff1f3; padding: 0.15em 0.4em; border-radius: 5px; color: #d63384; }
  /* Tables */
  .table-wrap { overflow-x: auto; margin: 0.6rem 0; border-radius: 10px; border: 1px solid #e1e4e8; }
  table { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
  th { background: #f6f8fa; color: #24292e; font-weight: 600; text-align: left; padding: 0.55rem 0.75rem; border-bottom: 2px solid #e1e4e8; }
  td { padding: 0.45rem 0.75rem; border-bottom: 1px solid #eaecef; color: #24292e; }
  tr:nth-child(even) { background: #fafbfc; }
  /* Mermaid */
  .mermaid { margin: 0.75rem 0; text-align: center; background: #fafbfc; border-radius: 10px; padding: 0.75rem; border: 1px solid #e1e4e8; }
  .mermaid svg { max-width: 100%; height: auto; }
  /* Charts */
  .dynamic-chart { margin: 0.75rem 0; background: #fafbfc; border: 1px solid #e1e4e8; border-radius: 10px; padding: 0.85rem; }
  .dynamic-chart canvas { max-height: 320px; }
  /* Timeline */
  .timeline { margin: 0.75rem 0; padding-left: 1.5rem; border-left: 2px solid #d1d5db; }
  .tl-item { position: relative; padding: 0.4rem 0 0.8rem 1rem; }
  .tl-dot { position: absolute; left: -1.75rem; top: 0.65rem; width: 10px; height: 10px; border-radius: 50%; border: 2px solid #d1d5db; background: #f0f2f5; }
  .tl-done .tl-dot { background: #22c55e; border-color: #22c55e; }
  .tl-active .tl-dot { background: #f59e0b; border-color: #f59e0b; }
  .tl-pending .tl-dot { background: #d1d5db; border-color: #d1d5db; }
  .tl-date { font-size: 0.68rem; color: #8b8b8b; }
  .tl-title { font-size: 0.82rem; color: #1a1a1a; font-weight: 500; }
  .tl-desc { font-size: 0.78rem; color: #6b7280; margin-top: 0.15rem; }
  /* Footer */
  .footer { margin-top: 2rem; padding-top: 1rem; text-align: center; }
  .footer p { font-size: 0.68rem; color: #aaa; }
  .footer a { color: #888; text-decoration: none; }
  .footer a:hover { color: #555; }
  @media (max-width: 640px) { .container { padding: 0.75rem 0.5rem; } .msg-user { max-width: 92%; } .msg-body { font-size: 0.84rem; padding: 0.7rem 0.9rem; } }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>${esc(title)}</h1>
    <div class="meta">
      <span>공유: ${sharedDate}</span>
      ${expiresDate ? `<span>만료: ${expiresDate}</span>` : ''}
      <span class="badge">읽기 전용 스냅샷</span>
    </div>
  </div>
  <div class="chat-thread">
  ${messagesHtml}
  </div>
  <div class="footer">
    <p>Powered by <a href="https://tower.tower.example.com" target="_blank">Tower</a></p>
  </div>
</div>
<script>
  // Initialize Mermaid — manual render using textContent
  // because the HTML parser converts --> to --&gt; in innerHTML,
  // which breaks mermaid's arrow syntax.
  mermaid.initialize({
    startOnLoad: false,
    theme: 'default',
    themeVariables: {
      primaryColor: '#dbeafe',
      primaryTextColor: '#1e3a5f',
      primaryBorderColor: '#93c5fd',
      lineColor: '#6b7280',
      secondaryColor: '#ede9fe',
      tertiaryColor: '#f0fdf4',
      background: '#ffffff',
      mainBkg: '#dbeafe',
      nodeBorder: '#93c5fd',
      clusterBkg: '#f8fafc',
      clusterBorder: '#cbd5e1',
      titleColor: '#1a1a1a',
      edgeLabelBackground: '#ffffff',
    },
    flowchart: { useMaxWidth: true, htmlLabels: true },
    sequence: { useMaxWidth: true },
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  });

  // Syntax highlighting + Mermaid manual render
  document.addEventListener('DOMContentLoaded', async () => {
    // Mermaid: use textContent (not innerHTML) to avoid HTML parser mangling --> to --&gt;
    const mermaidDivs = document.querySelectorAll('.mermaid');
    for (let i = 0; i < mermaidDivs.length; i++) {
      const div = mermaidDivs[i];
      const code = div.textContent || '';
      const id = 'mermaid-render-' + i;
      try {
        const { svg } = await mermaid.render(id, code);
        div.innerHTML = svg;
      } catch (e) {
        div.innerHTML = '<pre style="color:#dc2626;font-size:0.78rem;background:#fef2f2;padding:0.5rem;border-radius:6px;">' + code + '</pre>';
      }
    }

    document.querySelectorAll('pre code[class*="language-"]').forEach(el => {
      try { hljs.highlightElement(el); } catch {}
    });

    // Render Chart.js charts
    document.querySelectorAll('.dynamic-chart canvas[data-chart]').forEach(el => {
      try {
        const config = JSON.parse(el.getAttribute('data-chart'));
        const type = config.type === 'area' ? 'line' : config.type || 'bar';
        const xKey = config.xKey || 'name';
        const yKeys = config.yKey ? [config.yKey] : Object.keys(config.data?.[0] || {}).filter(k => k !== xKey);
        const colors = ['#60a5fa', '#a78bfa', '#34d399', '#fbbf24', '#f87171', '#fb923c'];
        new Chart(el, {
          type,
          data: {
            labels: (config.data || []).map(d => d[xKey]),
            datasets: yKeys.map((key, i) => ({
              label: key,
              data: (config.data || []).map(d => d[key]),
              backgroundColor: type === 'pie' ? colors : colors[i % colors.length] + '33',
              borderColor: colors[i % colors.length],
              borderWidth: type === 'pie' ? 1 : 2,
              fill: config.type === 'area',
              tension: 0.3,
            })),
          },
          options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: { legend: { labels: { color: '#4b5563' } } },
            scales: type === 'pie' ? {} : {
              x: { ticks: { color: '#6b7280' }, grid: { color: '#e5e7eb' } },
              y: { ticks: { color: '#6b7280' }, grid: { color: '#e5e7eb' } },
            },
          },
        });
      } catch (e) { console.warn('Chart render failed:', e); }
    });
  });
<\/script>
</body>
</html>`;
}

/** Error page for expired/invalid shared sessions */
function renderSharedSessionError(reason: string): string {
  const message = reason === 'expired'
    ? '이 공유 링크는 만료되었거나 취소되었습니다.'
    : reason === 'not found'
    ? '존재하지 않는 공유 링크입니다.'
    : '세션을 불러오는 중 오류가 발생했습니다.';
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>공유 세션 — Tower</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0a0a0b; color: #d1d5db; display: flex; align-items: center; justify-content: center; height: 100dvh; margin: 0; }
  .box { text-align: center; }
  .icon { font-size: 3rem; margin-bottom: 1rem; }
  p { font-size: 0.9rem; color: #9ca3af; }
</style>
</head>
<body>
<div class="box">
  <div class="icon">🔗</div>
  <p>${message}</p>
</div>
</body>
</html>`;
}

// Public AI Service serving must stay above Tower user auth so website password,
// visitor identity, Channel credentials, pointer checks and rate limits can enforce access.
if (config.aiServicesEnabled) router.use('/ai-service-public', aiServicePublicRouter);

// ───── Protected routes ─────
router.use(authMiddleware);

// /health lives above authMiddleware — see public section near the top of this file.

router.use('/runtime-box', runtimeBoxRouter);
router.use('/credential-vault', credentialVaultRouter);
router.use('/files/resumable-upload', resumableUploadRouter);
router.use('/personal-space', personalSpaceRouter);
router.use('/session-attachments', sessionAttachmentRouter);
router.use('/file-exchange', fileExchangeRouter);
router.use('/', projectFilesRouter);
router.use('/', sessionCoreRouter);
// Primary Agent creation is an Agent-first product capability on both Operator
// and self-hosted deployment VMs. Keeping this router behind towerRole=full made the
// visible managed hiring card POST to an unmounted endpoint and receive 404,
// while the AI tool path could still create the employee later.
if (config.agentFirstEnabled) router.use('/primary-agent-commands', primaryAgentRouter);
if (config.aiServicesEnabled) router.use('/ai-services', aiServiceRouter);
if (config.workspaceAppsEnabled) router.use('/workspace-apps', workspaceAppsRouter);
if (config.towerRole === 'full') router.use('/harnesses', harnessRouter);

// ─── Internal Beta: Skill Workbench ─────────────────────────────────────────
function betaWorkbenchGate(res: any): boolean {
  if (!isSkillWorkbenchEnabled()) {
    res.status(404).json({ error: 'Not found' });
    return false;
  }
  return true;
}

async function resolveWorkbenchProjectRoot(req: any, projectId: string | null): Promise<string | null | { error: { status: number; message: string } }> {
  if (!projectId) return null;
  const project = await queryOne<{ root_path: string }>('SELECT root_path FROM projects WHERE id = $1', [projectId]);
  if (!project) return { error: { status: 404, message: 'Project not found' } };
  const userId = req.user?.userId;
  const role = req.user?.role;
  if (userId && !(await isPathAccessible(project.root_path, userId, role))) {
    return { error: { status: 403, message: 'Project not accessible' } };
  }
  return project.root_path;
}

router.get('/beta/skill-workbench/history', (req, res) => {
  if (!betaWorkbenchGate(res)) return;
  const limit = parseInt(String(req.query.limit || '30'), 10) || 30;
  res.json({ history: listSkillWorkbenchHistory(limit, (req as any).user?.userId) });
});

router.get('/beta/skill-workbench/test-cases', (req, res) => {
  if (!betaWorkbenchGate(res)) return;
  res.json({ testCases: listSkillWorkbenchTestCases((req as any).user?.userId) });
});

router.post('/beta/skill-workbench/test-cases', (req, res) => {
  if (!betaWorkbenchGate(res)) return;
  try {
    const body = req.body || {};
    const saved = saveSkillWorkbenchTestCase({
      id: typeof body.id === 'string' ? body.id : null,
      title: typeof body.title === 'string' ? body.title : null,
      prompt: typeof body.prompt === 'string' ? body.prompt : '',
      projectId: typeof body.projectId === 'string' && body.projectId.trim() ? body.projectId.trim() : null,
      draftSkillName: typeof body.draftSkillName === 'string' ? body.draftSkillName : null,
      baselineSkillName: typeof body.baselineSkillName === 'string' ? body.baselineSkillName : null,
      notes: typeof body.notes === 'string' ? body.notes : null,
      ownerUserId: (req as any).user?.userId ?? null,
    });
    res.json({ testCase: saved });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'failed to save test case' });
  }
});

router.delete('/beta/skill-workbench/test-cases/:id', (req, res) => {
  if (!betaWorkbenchGate(res)) return;
  const deleted = deleteSkillWorkbenchTestCase(req.params.id as string, (req as any).user?.userId);
  res.json({ deleted });
});

router.post('/beta/skill-workbench/run', async (req, res) => {
  if (!betaWorkbenchGate(res)) return;
  try {
    const body = req.body || {};
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    const projectId = typeof body.projectId === 'string' && body.projectId.trim() ? body.projectId.trim() : null;
    const draftSkillName = typeof body.draftSkillName === 'string' && body.draftSkillName.trim() ? body.draftSkillName.trim() : null;
    const baselineSkillName = typeof body.baselineSkillName === 'string' && body.baselineSkillName.trim() ? body.baselineSkillName.trim() : null;
    const testCaseId = typeof body.testCaseId === 'string' && body.testCaseId.trim() ? body.testCaseId.trim() : null;
    if (!prompt.trim()) return res.status(400).json({ error: 'prompt is required' });

    const projectRoot = await resolveWorkbenchProjectRoot(req as any, projectId);
    if (projectRoot && typeof projectRoot === 'object' && 'error' in projectRoot) {
      return res.status(projectRoot.error.status).json({ error: projectRoot.error.message });
    }

    const result = await runSkillWorkbenchComparison({
      projectId,
      projectRoot,
      prompt,
      draftSkillName,
      baselineSkillName,
      testCaseId,
      saveToHistory: body.saveToHistory !== false,
      userId: (req as any).user?.userId,
      username: (req as any).user?.username,
    });
    res.json(result);
  } catch (err: any) {
    const message = err?.message || 'skill workbench run failed';
    const status = /disabled|not found|inactive/i.test(message) ? 400 : 500;
    res.status(status).json({ error: message });
  }
});

// ─── Live Meeting Recorder MVP ──────────────────────────────────────────────
router.post('/meeting-recorder/runs', async (req, res) => {
  try {
    const body = req.body || {};
    const run = await createMeetingRun({
      title: typeof body.title === 'string' ? body.title : undefined,
      source: typeof body.source === 'string' ? body.source as MeetingAudioSource : undefined,
      language: typeof body.language === 'string' ? body.language : undefined,
      saveAudio: typeof body.saveAudio === 'boolean' ? body.saveAudio : undefined,
    });
    res.json({ run });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'failed to create meeting run' });
  }
});

router.get('/meeting-recorder/runs/:id', async (req, res) => {
  try {
    const run = await getMeetingRun(req.params.id as string);
    res.json({ run });
  } catch (err: any) {
    res.status(404).json({ error: err?.message || 'meeting run not found' });
  }
});

router.post('/meeting-recorder/runs/:id/chunks', upload.single('audio'), async (req, res) => {
  try {
    const startMs = Number(req.body?.startMs ?? 0);
    const endMs = Number(req.body?.endMs ?? 0);
    const transcriptText = typeof req.body?.transcriptText === 'string' ? req.body.transcriptText : undefined;
    const result = await appendMeetingChunk(req.params.id as string, {
      startMs,
      endMs,
      transcriptText,
      mimeType: req.file?.mimetype,
      originalName: req.file?.originalname,
      audio: req.file?.buffer,
    });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'failed to append meeting chunk' });
  }
});

router.post('/meeting-recorder/runs/:id/end', async (req, res) => {
  try {
    const run = await endMeetingRun(req.params.id as string);
    res.json({ run });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'failed to end meeting run' });
  }
});

// ─── Cross-project maintenance grants (admin/operator) ──────────────────────
router.get('/maintenance/cross-project-grants', async (req, res) => {
  const user = (req as any).user;
  if (!isAdminOrOperator(user?.role)) return res.status(403).json({ error: 'admin/operator only' });
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
  const includeInactive = req.query.includeInactive === '1' || req.query.includeInactive === 'true';
  res.json(await listCrossProjectMaintenanceGrants({
    actorUserId: user.userId,
    sourceSessionId: sessionId,
    includeInactive,
  }));
});

router.post('/maintenance/cross-project-grants', async (req, res) => {
  try {
    const user = (req as any).user;
    if (!isAdminOrOperator(user?.role)) return res.status(403).json({ error: 'admin/operator only' });
    const grant = await createCrossProjectMaintenanceGrant({
      actorUserId: user.userId,
      sourceSessionId: typeof req.body?.sourceSessionId === 'string' ? req.body.sourceSessionId : null,
      reason: req.body?.reason,
      scopeType: req.body?.scopeType,
      projectIds: req.body?.projectIds,
      allowedPaths: req.body?.allowedPaths,
      mode: req.body?.mode,
      ttlMinutes: req.body?.ttlMinutes,
      metadata: req.body?.metadata,
    });
    res.json(grant);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'failed to create maintenance grant' });
  }
});

router.post('/maintenance/cross-project-grants/:id/revoke', async (req, res) => {
  const user = (req as any).user;
  if (!isAdminOrOperator(user?.role)) return res.status(403).json({ error: 'admin/operator only' });
  const ok = await revokeCrossProjectMaintenanceGrant(req.params.id as string, user.userId);
  res.json({ ok });
});

// ─── Workbench Worker service preview proxy ─────────────────────────────────
// Worker-first Projects can run long-lived services on the selected Worker. This
// narrow preview path authenticates through Tower, then proxies to the Worker
// control endpoint; the Worker itself only proxies ports for allowlisted Projects.
function writeParsedBodyOrPipe(req: any, proxyReq: http.ClientRequest): void {
  if (req.body !== undefined && req.body !== null && !['GET', 'HEAD'].includes(String(req.method).toUpperCase())) {
    const body = Buffer.isBuffer(req.body)
      ? req.body
      : typeof req.body === 'string'
        ? req.body
        : JSON.stringify(req.body);
    proxyReq.end(body);
    return;
  }
  req.pipe(proxyReq);
}

async function proxyWorkbenchWorkerPreview(req: any, res: any) {
  const workerId = String(req.params.workerId || '');
  const projectId = String(req.params.projectId || '');
  const port = Number(req.params.port);
  if (!workerId || !projectId || !Number.isInteger(port) || port < 1024 || port > 65535) {
    return res.status(400).json({ error: 'Invalid Worker preview target' });
  }

  const userId = (req as any).user?.userId;
  const role = (req as any).user?.role;
  if (!userId) return res.status(401).json({ error: 'Auth required' });
  if (!isPrivilegedRole(role) && !(await isProjectMember(projectId, userId))) {
    return res.status(403).json({ error: 'Access denied: not a project member' });
  }

  try {
    const [{ getPersistedWorkbenchWorker }, { resolveWorkbenchWorkerTransportToken }] = await Promise.all([
      import('../services/runtime-box/workbench-worker-repository.js'),
      import('../services/runtime-box/workbench-worker-transport-credentials.js'),
    ]);
    const worker = await getPersistedWorkbenchWorker(workerId, { staleAfterMs: 300_000 });
    if (!worker || !worker.projectIds.includes(projectId)) return res.status(404).json({ error: 'Worker preview target not found' });
    const token = await resolveWorkbenchWorkerTransportToken(workerId, userId);
    if (!token) return res.status(503).json({ error: 'Worker transport credential is not configured' });

    const suffix = req.params[0] ? `/${req.params[0]}` : '/';
    const query = typeof req.originalUrl === 'string' && req.originalUrl.includes('?')
      ? req.originalUrl.slice(req.originalUrl.indexOf('?'))
      : '';
    const targetUrl = new URL(`/v1/services/${encodeURIComponent(projectId)}/${port}${suffix}${query}`, worker.baseUrl);
    const headers = { ...req.headers } as Record<string, string | string[] | undefined>;
    delete headers.host;
    delete headers.connection;
    delete headers['content-length'];
    headers.authorization = `Bearer ${token}`;
    headers['x-forwarded-host'] = req.headers.host;
    headers['x-forwarded-proto'] = req.protocol;
    headers['x-tower-workbench-worker-id'] = workerId;

    const proxyReq = http.request(targetUrl, { method: req.method, headers }, (proxyRes) => {
      res.statusCode = proxyRes.statusCode || 502;
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (value !== undefined) res.setHeader(key, value as any);
      }
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (err) => {
      if (!res.headersSent) res.status(502).json({ error: 'Worker preview proxy failed', message: err.message });
      else res.end();
    });
    writeParsedBodyOrPipe(req, proxyReq);
  } catch (err: any) {
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Worker preview error' });
  }
}

router.all('/workbench-workers/preview/:workerId/:projectId/:port', proxyWorkbenchWorkerPreview);
router.all('/workbench-workers/preview/:workerId/:projectId/:port/*', proxyWorkbenchWorkerPreview);

// ─── Project Runtime Box preview proxy ───────────────────────────────────────
// Path 방식 auth-required preview. service_start 가 만든 external_url 이 여기로 온다.
// WebSocket/HMR proxy 는 후속 단계; v1은 HTTP GET/assets 확인까지 담당.
function runtimeBoxPreviewSubPath(req: any, _token: string): string {
  // Keep the full mounted path when proxying. Dev servers such as Vite can be
  // configured with TOWER_RUNTIME_BOX_PREVIEW_BASE and then expect requests at
  // /api/runtime-box/preview/<token>/..., not stripped root paths.
  return req.originalUrl;
}

async function proxyRuntimeBoxPreview(req: any, res: any) {
  const token = req.params.token as string;
  try {
    const { getPreviewTargetByToken } = await import('../services/runtime-box/service-registry.js');
    const target = await getPreviewTargetByToken(token);
    if (!target) return res.status(404).json({ error: 'Runtime Box preview not found or not running' });

    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (!userId) return res.status(401).json({ error: 'Auth required' });
    if (!isPrivilegedRole(role) && !(await isProjectMember(target.service.project_id, userId))) {
      return res.status(403).json({ error: 'Access denied: not a project member' });
    }

    const targetUrl = new URL(runtimeBoxPreviewSubPath(req, token), target.targetBaseUrl);
    const headers = { ...req.headers } as Record<string, string | string[] | undefined>;
    delete headers.host;
    delete headers.connection;
    delete headers['content-length'];
    headers['x-forwarded-host'] = req.headers.host;
    headers['x-forwarded-proto'] = req.protocol;
    headers['x-tower-runtime-box-service-id'] = String(target.service.id);

    const proxyReq = http.request(targetUrl, {
      method: req.method,
      headers,
    }, (proxyRes) => {
      res.statusCode = proxyRes.statusCode || 502;
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (value !== undefined) res.setHeader(key, value as any);
      }
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.status(502).json({ error: 'Runtime Box preview proxy failed', message: err.message });
      } else {
        res.end();
      }
    });

    req.pipe(proxyReq);
  } catch (err: any) {
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Runtime Box preview error' });
  }
}

router.all('/runtime-box/preview/:token', proxyRuntimeBoxPreview);
router.all('/runtime-box/preview/:token/*', proxyRuntimeBoxPreview);

// ─── Deprecated browser proxy ───────────────────────────────────────────────
// Tower no longer proxies browser automation through a host-level daemon. Runtime Box
// Playwright/system Chromium is now the supported web-capture baseline because
// it keeps browser work project-scoped and reproducible. Keep these endpoints as
// explicit 410s for old frontend/admin callers instead of silently proxying to a
// host-global daemon.
function sendDeprecatedBrowserTool(res: Response) {
  res.status(410).json({
    ok: false,
    deprecated: true,
    error: 'The legacy browser proxy is deprecated. Use Runtime Box Playwright/web-capture instead.',
    replacement: 'runtime-box-playwright',
  });
}

router.get('/browser/health', (_req, res) => sendDeprecatedBrowserTool(res));
router.post('/browser/navigate', (_req, res) => sendDeprecatedBrowserTool(res));
router.get('/browser/text', (_req, res) => sendDeprecatedBrowserTool(res));
router.get('/browser/snapshot', (_req, res) => sendDeprecatedBrowserTool(res));
router.post('/browser/action', (_req, res) => sendDeprecatedBrowserTool(res));
router.get('/browser/screenshot', (_req, res) => sendDeprecatedBrowserTool(res));
// ─────────────────────────────────────────────────────────────────────────────

// ─── OAuth callback (Google) ────────────────────────────────────────────────
const GWS_CRED_DIR = path.join(os.homedir(), '.config', 'gws');
const GWS_PERSONAL_CONFIG_SECRET_NAME = 'GWS_PERSONAL_CONFIG_B64';

async function buildAgentGwsConfigBundle(opts: {
  accessToken: string;
  refreshToken: string;
  scopes: string[];
}): Promise<string> {
  if (!config.googleClientId || !config.googleClientSecret || !config.googleRedirectUri) {
    throw new Error('Google OAuth client is not configured');
  }
  const clientConfig = {
    web: {
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uris: [config.googleRedirectUri],
    },
  };
  const tmpRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'tower-gws-agent-'));
  const tmpGwsDir = path.join(tmpRoot, 'gws');
  const tmpTarPath = path.join(tmpRoot, 'gws.tar.gz');
  try {
    await fsPromises.mkdir(tmpGwsDir, { recursive: true, mode: 0o700 });
    await fsPromises.writeFile(path.join(tmpGwsDir, 'client_secret.json'), JSON.stringify(clientConfig, null, 2), { mode: 0o600 });
    const creds = {
      type: 'authorized_user',
      token: opts.accessToken,
      refresh_token: opts.refreshToken,
      token_uri: 'https://oauth2.googleapis.com/token',
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      scopes: opts.scopes,
    };
    const tokenCache = {
      access_token: opts.accessToken,
      refresh_token: opts.refreshToken,
      token_uri: 'https://oauth2.googleapis.com/token',
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      scopes: opts.scopes,
      expiry: '',
    };
    await fsPromises.writeFile(path.join(tmpGwsDir, 'credentials.json'), JSON.stringify(creds, null, 2), { mode: 0o600 });
    await fsPromises.writeFile(path.join(tmpGwsDir, 'token_cache.json'), JSON.stringify(tokenCache, null, 2), { mode: 0o600 });
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    await promisify(execFile)('tar', ['-C', tmpRoot, '-czf', tmpTarPath, 'gws'], { timeout: 30_000 });
    return await fsPromises.readFile(tmpTarPath, 'base64');
  } finally {
    await fsPromises.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function savePersonalGwsConfigSecretFromToken(opts: {
  userId: number;
  accessToken: string;
  refreshToken: string;
  scopes: string[];
}): Promise<void> {
  if (!config.googleClientId || !config.googleClientSecret || !config.googleRedirectUri) {
    throw new Error('Google OAuth client is not configured');
  }
  const clientConfig = {
    web: {
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uris: [config.googleRedirectUri],
    },
  };
  const tmpRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), `tower-gws-personal-${opts.userId}-`));
  const tmpGwsDir = path.join(tmpRoot, 'gws');
  const tmpUserDir = path.join(tmpGwsDir, 'users', String(opts.userId));
  const tmpTarPath = path.join(tmpRoot, 'gws.tar.gz');
  try {
    await fsPromises.mkdir(tmpUserDir, { recursive: true, mode: 0o700 });
    await fsPromises.writeFile(path.join(tmpGwsDir, 'client_secret.json'), JSON.stringify(clientConfig, null, 2), { mode: 0o600 });
    const creds = {
      type: 'authorized_user',
      token: opts.accessToken,
      refresh_token: opts.refreshToken,
      token_uri: 'https://oauth2.googleapis.com/token',
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      scopes: opts.scopes,
    };
    const tokenCache = {
      access_token: opts.accessToken,
      refresh_token: opts.refreshToken,
      token_uri: 'https://oauth2.googleapis.com/token',
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      scopes: opts.scopes,
      expiry: '',
    };
    await fsPromises.writeFile(path.join(tmpUserDir, 'credentials.json'), JSON.stringify(creds, null, 2), { mode: 0o600 });
    await fsPromises.writeFile(path.join(tmpUserDir, 'token_cache.json'), JSON.stringify(tokenCache, null, 2), { mode: 0o600 });
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    await execFileAsync('tar', ['-C', tmpRoot, '-czf', tmpTarPath, 'gws'], { timeout: 30_000 });
    const encoded = await fsPromises.readFile(tmpTarPath, 'base64');
    await setSecret({
      name: GWS_PERSONAL_CONFIG_SECRET_NAME,
      value: encoded,
      scope: 'user',
      ownerUserId: opts.userId,
      createdBy: opts.userId,
      description: 'Personal Google Workspace CLI config bundle for Project Runtime Box',
    });
  } finally {
    await fsPromises.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

function parseGwsTowerUserState(state: unknown): number | null {
  const m = typeof state === 'string' ? state.match(/^tower_user:(\d+)$/) : null;
  if (!m) return null;
  const userId = Number(m[1]);
  return Number.isSafeInteger(userId) && userId > 0 ? userId : null;
}

router.get('/oauth/google/callback', async (req, res) => {
  const code = req.query.code as string | undefined;
  const error = req.query.error as string | undefined;

  if (error) {
    return res.status(400).send(oauthResultPage(false, `Login denied: ${error}`));
  }
  if (!code) {
    return res.status(400).send(oauthResultPage(false, 'Missing authorization code'));
  }

  try {
    // Read client config
    const secretPath = path.join(GWS_CRED_DIR, 'client_secret.json');
    const secret = JSON.parse(fs.readFileSync(secretPath, 'utf-8'));
    const info = secret.installed || secret.web || {};
    const clientId = info.client_id;
    const clientSecret = info.client_secret;

    // Determine redirect_uri (must match what was used in the auth request)
    const publicUrl = config.publicUrl || `${req.protocol}://${req.get('host')}`;
    const redirectUri = `${publicUrl}/api/oauth/google/callback`;

    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    const tokens = await tokenRes.json() as Record<string, any>;
    if (tokens.error) {
      return res.status(400).send(oauthResultPage(false, `Token error: ${tokens.error_description || tokens.error}`));
    }

    // Save credentials in gws format. New Tower GWS CLI uses users/<id>/;
    // keep legacy root files as a compatibility cache for older host scripts.
    const towerUserId = parseGwsTowerUserState(req.query.state);
    const targetDir = towerUserId ? path.join(GWS_CRED_DIR, 'users', String(towerUserId)) : GWS_CRED_DIR;
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    const creds = {
      type: 'authorized_user',
      token: tokens.access_token,
      refresh_token: tokens.refresh_token || '',
      token_uri: 'https://oauth2.googleapis.com/token',
      client_id: clientId,
      client_secret: clientSecret,
      scopes: (req.query.scope as string || '').split(' ').filter(Boolean),
    };
    fs.writeFileSync(path.join(targetDir, 'credentials.json'), JSON.stringify(creds, null, 2), { mode: 0o600 });

    // Update token cache
    const tokenCache = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || '',
      token_uri: 'https://oauth2.googleapis.com/token',
      client_id: clientId,
      client_secret: clientSecret,
      scopes: creds.scopes,
      expiry: '',
    };
    fs.writeFileSync(path.join(targetDir, 'token_cache.json'), JSON.stringify(tokenCache, null, 2), { mode: 0o600 });
    if (towerUserId) {
      await savePersonalGwsConfigSecretFromToken({
        userId: towerUserId,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || '',
        scopes: creds.scopes,
      });
    } else {
      fs.writeFileSync(path.join(GWS_CRED_DIR, 'credentials.json'), JSON.stringify(creds, null, 2), { mode: 0o600 });
      fs.writeFileSync(path.join(GWS_CRED_DIR, 'token_cache.json'), JSON.stringify(tokenCache, null, 2), { mode: 0o600 });
    }

    res.send(oauthResultPage(true, towerUserId ? 'Google login successful. Personal GWS credential saved to Tower Vault.' : 'Google login successful!'));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).send(oauthResultPage(false, `Server error: ${message}`));
  }
});

function oauthResultPage(success: boolean, message: string): string {
  const color = success ? '#10b981' : '#ef4444';
  const icon = success ? '&#10003;' : '&#10007;';
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>OAuth ${success ? 'Success' : 'Error'}</title>
<style>
  body { font-family: -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #111; color: #eee; }
  .card { text-align: center; padding: 3rem; border-radius: 1rem; border: 1px solid ${color}33; background: ${color}11; max-width: 420px; }
  .icon { font-size: 3rem; color: ${color}; margin-bottom: 1rem; }
  h2 { margin: 0 0 0.5rem; }
  p { color: #999; font-size: 0.9rem; }
  .close-btn { margin-top: 1.5rem; padding: 0.5rem 2rem; border-radius: 0.5rem; border: 1px solid #333; background: #222; color: #eee; cursor: pointer; font-size: 0.9rem; }
  .close-btn:hover { background: #333; }
</style></head>
<body><div class="card">
  <div class="icon">${icon}</div>
  <h2>${success ? 'Login Complete' : 'Login Failed'}</h2>
  <p>${message}</p>
  <button class="close-btn" onclick="window.close()">Close Window</button>
  ${success ? '<script>setTimeout(()=>window.close(),3000)</script>' : ''}
</div></body></html>`;
}
// ─────────────────────────────────────────────────────────────────────────────

// ───── Users list (for share modal dropdown) ─────
router.get('/users', async (req, res) => {
  const currentUserId = (req as any).user?.userId;
  const users = (await query('SELECT id, username FROM users WHERE disabled = 0 ORDER BY username'))
    .filter((u: any) => u.id !== currentUserId);
  res.json(users);
});

// ───── Short authenticated file links ─────
router.post('/file-links', async (req, res) => {
  try {
    const { filePath } = req.body;
    const ownerId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (!ownerId) return res.status(401).json({ error: 'Unauthorized' });
    if (!filePath) return res.status(400).json({ error: 'filePath required' });

    const resolvedPath = expandHome(filePath);
    if (isDotfileDenied(resolvedPath)) return res.status(403).json({ error: 'Access denied: system path' });
    if (!(await isPathAccessible(resolvedPath, ownerId, role))) return res.status(403).json({ error: 'Access denied' });

    const link = await createFileLink(resolvedPath, ownerId);
    return res.json({ ...link, url: `/f/${link.short_id}` });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/file-links/:shortId', async (req, res) => {
  try {
    const shortId = req.params.shortId as string;
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!/^[A-Za-z0-9_-]{4,32}$/.test(shortId)) return res.status(400).json({ error: 'Invalid file link id' });

    const link = await getFileLinkByShortId(shortId);
    if (!link) return res.status(404).json({ error: 'File link not found' });
    if (isDotfileDenied(link.file_path)) return res.status(403).json({ error: 'Access denied: system path' });
    if (!(await isPathAccessible(link.file_path, userId, role))) return res.status(403).json({ error: 'Access denied' });

    return res.json({ path: link.file_path, filePath: link.file_path, shortId: link.short_id });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ───── Shares ─────
router.post('/shares', async (req, res) => {
  const { shareType, filePath, targetUserId, expiresIn } = req.body;
  const ownerId = (req as any).user?.userId;
  if (!ownerId) return res.status(401).json({ error: 'Unauthorized' });
  if (!filePath) return res.status(400).json({ error: 'filePath required' });
  try {
    if (shareType === 'internal') {
      if (!targetUserId) return res.status(400).json({ error: 'targetUserId required' });
      const share = await createInternalShare(filePath, ownerId, targetUserId);
      return res.json(share);
    } else if (shareType === 'external') {
      const share = await createExternalShare(filePath, ownerId, expiresIn || '24h');
      const url = `/shared/${share.token}`;
      return res.json({ ...share, url });
    } else {
      return res.status(400).json({ error: 'shareType must be internal or external' });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// IMPORTANT: register static /shares/* routes BEFORE /shares/:id to avoid Express matching them as :id
router.get('/shares/with-me', async (req, res) => {
  const userId = (req as any).user?.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  res.json(await getSharesWithMe(userId));
});

router.get('/shares/external', async (req, res) => {
  const ownerId = (req as any).user?.userId;
  if (!ownerId) return res.status(401).json({ error: 'Unauthorized' });
  const shares = await getExternalSharesByOwner(ownerId);
  const now = Date.now();
  res.json(shares.map((share) => {
    const fileName = path.basename(share.file_path);
    const ext = path.extname(fileName).slice(1).toLowerCase();
    const expiresAt = share.expires_at || null;
    const projectsRoot = path.resolve(config.workspaceRoot, 'projects');
    const resolvedPath = path.resolve(share.file_path);
    const relToProjects = resolvedPath.startsWith(projectsRoot + path.sep)
      ? path.relative(projectsRoot, resolvedPath)
      : '';
    const project = relToProjects ? relToProjects.split(path.sep)[0] : undefined;
    return {
      ...share,
      fileName,
      name: fileName,
      ext,
      project,
      url: share.token ? `/shared/${share.token}` : null,
      expired: expiresAt ? new Date(expiresAt).getTime() < now : false,
    };
  }));
});

router.get('/shares', async (req, res) => {
  const ownerId = (req as any).user?.userId;
  const filePath = req.query.filePath as string;
  if (!ownerId || !filePath) return res.status(400).json({ error: 'filePath required' });
  res.json(await getSharesByFile(filePath, ownerId));
});

router.delete('/shares/:id', async (req, res) => {
  const ownerId = (req as any).user?.userId;
  if (!ownerId) return res.status(401).json({ error: 'Unauthorized' });
  const ok = await revokeShare(req.params.id as string, ownerId);
  if (!ok) return res.status(404).json({ error: 'Share not found or no permission to revoke.' });
  res.json({ ok: true });
});

// ───── Session Shares ─────
router.post('/session-shares', async (req, res) => {
  const { shareType, sessionId, targetUserId, expiresIn } = req.body;
  const ownerId = (req as any).user?.userId;
  if (!ownerId) return res.status(401).json({ error: 'Unauthorized' });
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  try {
    if (shareType === 'internal') {
      if (!targetUserId) return res.status(400).json({ error: 'targetUserId required' });
      const share = await createInternalSessionShare(sessionId, ownerId, targetUserId);
      return res.json(share);
    } else if (shareType === 'external') {
      const share = await createExternalSessionShare(sessionId, ownerId, expiresIn || '24h');
      const url = `/api/shared-session/${share.token}`;
      return res.json({ ...share, url });
    } else {
      return res.status(400).json({ error: 'shareType must be internal or external' });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/session-shares/with-me', async (req, res) => {
  const userId = (req as any).user?.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  res.json(await getSessionSharesWithMe(userId));
});

router.get('/session-shares', async (req, res) => {
  const ownerId = (req as any).user?.userId;
  const sessionId = req.query.sessionId as string;
  if (!ownerId || !sessionId) return res.status(400).json({ error: 'sessionId required' });
  res.json(await getSharesBySession(sessionId, ownerId));
});

router.delete('/session-shares/:id', async (req, res) => {
  const ownerId = (req as any).user?.userId;
  if (!ownerId) return res.status(401).json({ error: 'Unauthorized' });
  const ok = await revokeSessionShare(req.params.id as string, ownerId);
  if (!ok) return res.status(404).json({ error: 'Share not found or no permission to revoke.' });
  res.json({ ok: true });
});

// ───── Admin: Models ─────

router.get('/admin/models', adminMiddleware, (_req, res) => {
  res.json(loadModelsFile());
});

router.get('/admin/inference-setup', adminMiddleware, (_req, res) => {
  res.json(inferenceSetupStatus());
});

router.post('/admin/inference-setup/probe', adminMiddleware, async (req, res) => {
  try {
    const result = await probeInferenceProvider({
      provider: req.body?.provider as PublicInferenceProvider,
      apiKey: String(req.body?.apiKey ?? ''),
      baseUrl: req.body?.baseUrl ? String(req.body.baseUrl) : undefined,
      modelId: req.body?.modelId ? String(req.body.modelId) : undefined,
    });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Provider connection failed' });
  }
});

router.post('/admin/inference-setup/apply', adminMiddleware, async (req, res) => {
  try {
    const actorUserId = Number((req as any).user?.userId ?? (req as any).user?.id);
    if (!Number.isInteger(actorUserId) || actorUserId <= 0) return res.status(401).json({ error: 'Authenticated admin required' });
    const result = await configureInferenceProvider({
      provider: req.body?.provider as PublicInferenceProvider,
      apiKey: String(req.body?.apiKey ?? ''),
      baseUrl: req.body?.baseUrl ? String(req.body.baseUrl) : undefined,
      modelId: req.body?.modelId ? String(req.body.modelId) : undefined,
      actorUserId,
    });
    const reloaded = reloadModels();
    const piEngine = await getEngine('pi') as any;
    await piEngine.reloadModelRegistry?.();
    broadcast({ type: 'config_update', models: config.claudeEnabled ? reloaded.claude : [], piModels: config.piEnabled ? reloaded.pi : [], localModels: config.localEnabled ? reloaded.local : [], defaults: reloaded.defaults, claudeEnabled: config.claudeEnabled, piEnabled: config.piEnabled, localEnabled: config.localEnabled });
    res.json({ ok: true, ...result, readiness: getInferenceProviderReadiness() });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Provider setup failed' });
  }
});

router.put('/admin/models', adminMiddleware, (req, res) => {
  try {
    const data = req.body;
    if (!data.claude || !data.pi) return res.status(400).json({ error: 'claude and pi arrays required' });
    saveModelsFile(data);
    const reloaded = reloadModels();
    // Broadcast updated model list to all connected clients
    broadcast({
      type: 'config_update',
      models: config.claudeEnabled ? reloaded.claude : [],
      piModels: config.piEnabled ? reloaded.pi : [],
      localModels: config.localEnabled ? reloaded.local : [],
      defaults: reloaded.defaults,
      claudeEnabled: config.claudeEnabled,
      piEnabled: config.piEnabled,
      localEnabled: config.localEnabled
    });
    res.json({ ok: true, ...reloaded });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ───── Admin diagnostics: session project/cwd context drift ─────
// Decks are project-scoped labels, but old session moves and legacy creation
// paths can leave sessions with project_id=A while cwd points at workspace root
// or another project. Do not auto-fix: report first so operators can decide
// whether a session intentionally works in a non-project cwd.
router.get('/admin/session-context-diagnostics', operatorOrAboveMiddleware, async (req, res) => {
  try {
    const limitRaw = Number(req.query.limit ?? 100);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 500) : 100;
    const projectId = typeof req.query.projectId === 'string' && req.query.projectId.trim() ? req.query.projectId.trim() : null;
    const includeArchived = req.query.includeArchived === '1' || req.query.includeArchived === 'true';

    const params: unknown[] = [config.workspaceRoot];
    const where: string[] = [
      `s.project_id IS NOT NULL`,
      `s.cwd IS NOT NULL`,
      `p.root_path IS NOT NULL`,
      `NOT (s.cwd = p.root_path OR s.cwd LIKE p.root_path || '/%')`,
    ];
    if (!includeArchived) where.push(`COALESCE(s.archived, 0) = 0`);
    if (projectId) {
      params.push(projectId);
      where.push(`s.project_id = $${params.length}`);
    }
    params.push(limit);

    const rows = await query(
      `SELECT s.id,
              s.short_code,
              s.name AS session_name,
              s.label,
              s.project_id,
              p.name AS project_name,
              p.root_path AS project_root,
              s.cwd,
              s.user_id,
              COALESCE(u.display_name, u.username, 'user:' || s.user_id::text) AS owner_name,
              s.engine,
              s.updated_at,
              CASE
                WHEN s.cwd = $1 THEN 'workspace-root'
                WHEN EXISTS (
                  SELECT 1
                    FROM projects p2
                   WHERE p2.id <> s.project_id
                     AND p2.root_path IS NOT NULL
                     AND (s.cwd = p2.root_path OR s.cwd LIKE p2.root_path || '/%')
                ) THEN 'other-project-root'
                ELSE 'outside-project-root'
              END AS drift_kind
         FROM sessions s
         JOIN projects p ON p.id = s.project_id
         LEFT JOIN users u ON u.id = s.user_id
        WHERE ${where.join(' AND ')}
        ORDER BY s.updated_at DESC NULLS LAST
        LIMIT $${params.length}`,
      params,
    );

    res.json({ ok: true, count: rows.length, limit, includeArchived, projectId, rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'session context diagnostics failed' });
  }
});

// ───── Admin: Reload library skills + reconcile providers ─────
// 2026-04-17 재설계 이후: company 스킬은 DB에 저장하지 않음. library.yaml + SKILL.md 가
// 단일 소스이므로 reconcile 은 단지 (1) in-memory 캐시 무효화, (2) skill_providers 에서
// 고아 row 제거 + 신규 provider 동기화 만 하면 된다. `.managed-manifest.json` 경로는
// 더 이상 사용하지 않는다. 엔드포인트 경로는 호환을 위해 유지.
router.post('/admin/skills/reconcile-managed', operatorOrAboveMiddleware, async (_req, res) => {
  try {
    invalidateLibraryCache();
    const result = await bootstrapLibraryProviders();
    res.json({ ok: true, synced: result.synced, orphansRemoved: result.orphansRemoved });
  } catch (err: any) {
    console.error('[reconcile-managed] failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ───── Admin: Claude Accounts (credential rotation) ─────
import {
  listAccounts, addAccount, updateAccount, removeAccount,
  assignAccountToProject, getProjectAccountId,
} from '../services/auth/credential-store.js';
import { readCredentialHealth } from '../services/auth/credential-health.js';

function decodeJwtPayload(token: string): any | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const padded = part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - part.length % 4) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function getLatestCodexUsageSnapshot() {
  try {
    const file = path.join(config.workspaceRoot, '.audit', 'codex-usage.jsonl');
    if (!fs.existsSync(file)) return null;
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const snapshot = JSON.parse(lines[i]);
        if (snapshot?.rateLimits) return snapshot;
      } catch {}
    }
    return null;
  } catch {
    return null;
  }
}

function getCodexAuthStatus() {
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
  const authPath = path.join(agentDir, 'auth.json');
  const exists = fs.existsSync(authPath);
  const latestUsage = getLatestCodexUsageSnapshot();
  if (!exists) {
    return { configured: false, agentDir, authPath, provider: 'openai-codex', latestUsage };
  }
  const raw = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  const creds = raw?.['openai-codex'];
  if (!creds) {
    return { configured: false, agentDir, authPath, provider: 'openai-codex', latestUsage };
  }
  const payload = typeof creds.access === 'string' ? decodeJwtPayload(creds.access) : null;
  const authClaim = payload?.['https://api.openai.com/auth'] || {};
  const profile = payload?.['https://api.openai.com/profile'] || {};
  const expiresAt = typeof creds.expires === 'number' ? new Date(creds.expires).toISOString() : null;
  return {
    configured: true,
    provider: 'openai-codex',
    type: creds.type || 'oauth',
    agentDir,
    authPath,
    accountId: creds.accountId || authClaim.chatgpt_account_id || null,
    email: profile.email || null,
    planType: authClaim.chatgpt_plan_type || null,
    expiresAt,
    expired: typeof creds.expires === 'number' ? Date.now() > creds.expires : null,
    latestUsage,
  };
}

router.get('/admin/openai-codex-auth/status', adminMiddleware, (_req, res) => {
  try {
    res.json(getCodexAuthStatus());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

async function handleAiUsageMetrics(req: any, res: any) {
  try {
    const { listAiTokenBudgetSnapshots } = await import('../services/ai/ai-token-budget.js');
    const days = Math.max(1, Math.min(parseInt(String(req.query.days || '30'), 10) || 30, 180));
    const result = await listAiTokenBudgetSnapshots(days);
    res.json({ ...result, capturedAt: new Date().toISOString() });
  } catch (err: any) {
    console.error('[metrics/ai-usage] failed:', err);
    res.status(500).json({ error: err?.message ?? 'failed to read AI usage' });
  }
}

router.get('/metrics/ai-usage', operatorOrAboveMiddleware, handleAiUsageMetrics);
router.get('/admin/ai-token-budgets', adminMiddleware, handleAiUsageMetrics);

router.get('/admin/claude-accounts', adminMiddleware, async (req, res) => {
  try {
    const accounts = await listAccounts();
    // Opt-in health enrichment (?health=true). Default off keeps the endpoint
    // backward-compatible — existing admin UI clients get the same shape.
    // Phase 1 of 2026-05-25-multi-account-multi-provider-umbrella.md
    if (req.query.health === 'true' || req.query.health === '1') {
      const enriched = await Promise.all(
        accounts.map(async (acc) => ({
          ...acc,
          health: await readCredentialHealth(acc.configDir),
        }))
      );
      return res.json(enriched);
    }
    res.json(accounts);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/claude-accounts', adminMiddleware, async (req, res) => {
  const { id, label, configDir, tier, isDefault } = req.body;
  if (!id || !label || !configDir) {
    return res.status(400).json({ error: 'id, label, and configDir are required' });
  }
  try {
    const account = await addAccount({ id, label, configDir, tier, isDefault });
    res.json(account);
  } catch (err: any) {
    if (err.message?.includes('UNIQUE') || err.message?.includes('unique') || err.message?.includes('duplicate')) {
      return res.status(409).json({ error: 'Account ID or configDir already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.put('/admin/claude-accounts/:id', adminMiddleware, async (req, res) => {
  const { label, configDir, tier, isDefault, enabled } = req.body;
  try {
    const updated = await updateAccount(req.params.id as string, { label, configDir, tier, isDefault, enabled });
    if (!updated) return res.status(404).json({ error: 'Account not found' });
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/admin/claude-accounts/:id', adminMiddleware, async (req, res) => {
  try {
    const ok = await removeAccount(req.params.id as string);
    if (!ok) return res.status(404).json({ error: 'Account not found' });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Assign account to project
router.put('/admin/projects/:projectId/claude-account', adminMiddleware, async (req, res) => {
  const { accountId } = req.body; // null to unassign
  try {
    await assignAccountToProject(req.params.projectId as string, accountId);
    res.json({ ok: true, projectId: req.params.projectId, accountId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/projects/:projectId/claude-account', adminMiddleware, async (req, res) => {
  try {
    const accountId = await getProjectAccountId(req.params.projectId as string);
    res.json({ projectId: req.params.projectId, accountId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ───── Admin: System Prompts ─────
import { listSystemPrompts, upsertSystemPrompt, deleteSystemPrompt } from '../services/system-prompt.js';

router.get('/admin/system-prompts', adminMiddleware, async (_req, res) => {
  res.json(await listSystemPrompts());
});

router.get('/admin/prompt-inspector/:sessionId', adminMiddleware, async (req, res) => {
  try {
    const actor = (req as any).user;
    const { inspectSessionPrompt } = await import('../services/prompt-inspector/prompt-inspector.js');
    res.json(await inspectSessionPrompt({
      sessionId: req.params.sessionId as string,
      inspectingUserId: actor.userId,
      inspectingUsername: actor.username || 'admin',
    }));
  } catch (err: any) {
    const status = err?.message === 'Session not found' ? 404 : 500;
    res.status(status).json({ error: err?.message || 'Prompt inspection failed' });
  }
});

router.put('/admin/system-prompts/:name', adminMiddleware, async (req, res) => {
  const name = req.params.name as string;
  const { prompt } = req.body;
  if (!prompt && prompt !== '') return res.status(400).json({ error: 'prompt is required' });
  const result = await upsertSystemPrompt(name, prompt);
  res.json(result);
});

router.delete('/admin/system-prompts/:name', adminMiddleware, async (req, res) => {
  const name = req.params.name as string;
  const ok = await deleteSystemPrompt(name);
  if (!ok) return res.status(400).json({ error: 'Cannot delete the default prompt' });
  res.json({ ok: true });
});

// ───── Service tokens (admin only) ─────
// Long-lived scoped JWTs for fleet et al. Audited in service_tokens table.
// 결정: workspace/decisions/2026-05-27-fleet-service-tokens.md
// Issue: https://github.com/juliuschun/tower/issues/36

router.post('/admin/service-tokens', adminMiddleware, async (req, res) => {
  try {
    const { isKnownScope } = await import('../services/auth/auth.js');
    const { issueServiceToken } = await import('../services/auth/service-tokens.js');

    const aud = String(req.body?.aud ?? '');
    const userId = Number(req.body?.userId);
    const username = String(req.body?.username ?? '');
    const role = String(req.body?.role ?? '');
    const issuedFor = String(req.body?.issuedFor ?? '');
    const expiresIn = req.body?.expiresIn ? String(req.body.expiresIn) : undefined;

    if (!isKnownScope(aud)) {
      return res.status(400).json({ error: `Unknown scope: ${aud}` });
    }
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: 'userId must be a positive integer' });
    }
    if (!username || !role || !issuedFor) {
      return res.status(400).json({ error: 'username, role, issuedFor are required' });
    }

    const issued = await issueServiceToken({
      aud,
      userId,
      username,
      role,
      issuedFor,
      expiresIn,
    });
    res.json({
      token: issued.token,
      jti: issued.jti,
      expiresAt: issued.expiresAt.toISOString(),
    });
  } catch (err: any) {
    console.error('[admin/service-tokens] issue failed:', err);
    res.status(500).json({ error: err?.message ?? 'issue failed' });
  }
});

router.get('/admin/service-tokens', adminMiddleware, async (req, res) => {
  try {
    const { listServiceTokens } = await import('../services/auth/service-tokens.js');
    const aud = req.query.aud ? String(req.query.aud) : undefined;
    const activeOnly = req.query.activeOnly === '1' || req.query.activeOnly === 'true';
    const rows = await listServiceTokens({ aud, activeOnly });
    // Never return the token itself (we don't store it; jti only).
    res.json(rows);
  } catch (err: any) {
    console.error('[admin/service-tokens] list failed:', err);
    res.status(500).json({ error: err?.message ?? 'list failed' });
  }
});

router.delete('/admin/service-tokens/:jti', adminMiddleware, async (req, res) => {
  try {
    const { revokeServiceToken } = await import('../services/auth/service-tokens.js');
    const jti = String(req.params.jti);
    const ok = await revokeServiceToken(jti);
    if (!ok) return res.status(404).json({ error: 'Unknown jti' });
    res.json({ ok: true, jti });
  } catch (err: any) {
    console.error('[admin/service-tokens] revoke failed:', err);
    res.status(500).json({ error: err?.message ?? 'revoke failed' });
  }
});

// ───── 본인 자가관리 (Me) ─────
// 누구나 자기 자신은 조회/수정 가능. UserMenu (우측 상단 드롭다운) 가 사용.
// username 자체 변경은 admin only (PATCH /api/admin/users/:id 의 username 필드).
// 결정: workspace/decisions/2026-05-20-members-name-affiliation-and-credentials.md

router.get('/me', authMiddleware, async (req, res) => {
  const currentUser = (req as any).user;
  const profile = await getOwnProfile(currentUser.userId);
  if (!profile) return res.status(404).json({ error: 'User not found' });
  res.json(profile);
});

router.patch('/me/profile', authMiddleware, async (req, res) => {
  const currentUser = (req as any).user;
  const { displayName, affiliation } = req.body;
  if (displayName === undefined && affiliation === undefined) {
    return res.status(400).json({ error: 'No fields to update' });
  }
  await updateUserProfile(currentUser.userId, { displayName, affiliation });
  const profile = await getOwnProfile(currentUser.userId);
  res.json(profile);
});

router.post('/me/password', authMiddleware, async (req, res) => {
  const currentUser = (req as any).user;
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: 'oldPassword and newPassword required' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  if (oldPassword === newPassword) {
    return res.status(400).json({ error: 'New password must differ from current password' });
  }
  const ok = await changeOwnPassword(currentUser.userId, oldPassword, newPassword);
  if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });

  // 새 토큰 발급 — 본인이 비번 바꾼 직후엔 그 자리에서 invalidate 되지 않아야 함.
  // password_changed_at = NOW() 가 박혔으니 옛 토큰은 다음 요청부터 거부.
  const fresh = generateToken({
    userId: currentUser.userId,
    username: currentUser.username,
    role: currentUser.role,
  });
  setTokenCookie(res, fresh);
  res.json({ ok: true, token: fresh });
});

// ───── User Management (admin/operator) ─────
// 2026-05-04: operator 도 사용자 관리 가능 (decisions/2026-05-04-five-role-model.md).
// 단 다음은 admin 만:
//   - role='admin' 으로 사용자 생성/변경 (escalation 차단)
//   - admin 역할 사용자에 대한 비활성화·역할변경·비번 리셋 (admin 보호)
router.get('/admin/users', operatorOrAboveMiddleware, async (_req, res) => {
  res.json(await listUsers());
});

// customer_manager 담당 VM 배정 UI용. 자체 호스팅 서버 registry 자체는 Tower 전역 운영
// 데이터라 admin 만 수정한다.
router.get('/admin/self-hosted-servers', adminMiddleware, async (_req, res) => {
  const rows = await query(
    `SELECT id, customer_name AS name, profile
       FROM gateway_customers
      WHERE is_active = true
      ORDER BY customer_name`,
  );
  res.json(rows);
});

router.get('/admin/signup-settings', adminMiddleware, async (_req, res) => {
  res.json({ approvalMode: await getSignupApprovalMode() });
});

router.patch('/admin/signup-settings', adminMiddleware, async (req, res) => {
  try {
    const currentUser = (req as any).user;
    const mode = req.body?.approvalMode === 'manual' ? 'manual' : 'auto';
    res.json({ approvalMode: await setSignupApprovalMode(mode, currentUser?.userId ?? null) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/ai/composer-settings', authMiddleware, async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await getAiComposerSettings());
});

router.get('/admin/ai-composer-settings', adminMiddleware, async (_req, res) => {
  res.json(await getAiComposerSettings());
});

router.patch('/admin/ai-composer-settings', adminMiddleware, async (req, res) => {
  try {
    const currentUser = (req as any).user;
    res.json(await setAiComposerSettings(req.body, currentUser?.userId ?? null));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/admin/signup-invites/recommend', adminMiddleware, async (req, res) => {
  res.json({ code: recommendInviteCode(req.query.label ? String(req.query.label) : undefined) });
});

router.get('/admin/signup-invites', adminMiddleware, async (_req, res) => {
  res.json(await listSignupInviteCodes());
});

router.post('/admin/signup-invites', adminMiddleware, async (req, res) => {
  try {
    const currentUser = (req as any).user;
    const invite = await createSignupInviteCode({
      code: req.body?.code ?? null,
      label: req.body?.label ?? null,
      defaultRole: req.body?.defaultRole ?? req.body?.default_role ?? 'member',
      maxUses: req.body?.maxUses ?? req.body?.max_uses ?? null,
      expiresAt: req.body?.expiresAt ?? req.body?.expires_at ?? null,
      createdBy: currentUser?.userId ?? null,
    });
    res.json(invite);
  } catch (err: any) {
    if (err.message?.includes('duplicate key') || err.message?.includes('unique')) {
      return res.status(409).json({ error: 'Invite code already exists' });
    }
    res.status(400).json({ error: err.message });
  }
});

router.patch('/admin/signup-invites/:id', adminMiddleware, async (req, res) => {
  const id = parseInt(req.params.id as string, 10);
  try {
    const invite = await updateSignupInviteCode(id, {
      label: req.body?.label,
      defaultRole: req.body?.defaultRole ?? req.body?.default_role,
      maxUses: req.body?.maxUses ?? req.body?.max_uses,
      expiresAt: req.body?.expiresAt ?? req.body?.expires_at,
      disabled: req.body?.disabled,
    });
    if (!invite) return res.status(404).json({ error: 'Invite code not found' });
    res.json(invite);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/admin/signup-invites/:id', adminMiddleware, async (req, res) => {
  const id = parseInt(req.params.id as string, 10);
  const ok = await deleteSignupInviteCode(id);
  if (!ok) return res.status(404).json({ error: 'Invite code not found' });
  res.json({ ok: true });
});

router.post('/admin/users/:id/approve', adminMiddleware, async (req, res) => {
  const userId = parseInt(req.params.id as string, 10);
  const currentUser = (req as any).user;
  const user = await approveSignupUser(userId, currentUser.userId);
  if (!user) return res.status(404).json({ error: 'Pending user not found' });
  res.json(user);
});

router.post('/admin/users/:id/reject', adminMiddleware, async (req, res) => {
  const userId = parseInt(req.params.id as string, 10);
  const currentUser = (req as any).user;
  const user = await rejectSignupUser(userId, currentUser.userId, req.body?.reason ?? null);
  if (!user) return res.status(404).json({ error: 'Pending user not found' });
  res.json(user);
});

router.put('/admin/users/:id/self-hosted-servers', adminMiddleware, async (req, res) => {
  const userId = parseInt(req.params.id as string, 10);
  const customerIds = Array.isArray(req.body?.customerIds) ? req.body.customerIds.map(String) : [];
  await query('DELETE FROM user_customer_vms WHERE user_id = $1', [userId]);
  for (const customerId of customerIds) {
    await query(
      `INSERT INTO user_customer_vms (user_id, customer_id, created_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, customer_id) DO NOTHING`,
      [userId, customerId, (req as any).user?.userId ?? null],
    );
  }
  res.json({ ok: true });
});

router.post('/admin/users', operatorOrAboveMiddleware, async (req, res) => {
  const { username, password, role, displayName, affiliation } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  const currentUser = (req as any).user;
  if ((role === 'admin' || role === 'customer_manager') && currentUser.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can create admin/customer_manager users' });
  }
  try {
    const user = await createUser(username, password, role || 'member', {
      displayName: displayName ?? null,
      affiliation: affiliation ?? null,
    });
    res.json({
      ...user,
      display_name: displayName ?? null,
      affiliation: affiliation ?? null,
    });
  } catch (error: any) {
    if (error instanceof InvalidUsernameError) {
      return res.status(400).json({ error: error.message });
    }
    if (error.message?.includes('UNIQUE') || error.message?.includes('duplicate key')) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    res.status(500).json({ error: error.message });
  }
});

router.patch('/admin/users/:id', operatorOrAboveMiddleware, async (req, res) => {
  const userId = parseInt(req.params.id as string);
  const currentUser = (req as any).user;
  const { role, username, displayName, affiliation, reason } = req.body;

  // ── Role 변경 가드 (기존 그대로) ──
  if (role !== undefined) {
    if (currentUser.userId === userId) return res.status(403).json({ error: 'Cannot change own role' });
    if (currentUser.role !== 'admin') {
      const targetRole = await getUserRole(userId);
      if (targetRole === 'admin') {
        return res.status(403).json({ error: 'Only admins can modify admin users' });
      }
      if (role === 'admin' || role === 'customer_manager') {
        return res.status(403).json({ error: 'Only admins can grant admin/customer_manager role' });
      }
    }
    await updateUserRole(userId, role);
  }

  // ── allowed_path deprecated (2026-06-10) ──
  // Access scope is derived from role + project membership. Keep accepting old
  // clients' payloads but do not persist per-user work directories anymore.

  // ── username 변경 (admin 의 username 은 admin only) ──
  if (username !== undefined) {
    if (currentUser.role !== 'admin') {
      const targetRole = await getUserRole(userId);
      if (targetRole === 'admin') {
        return res.status(403).json({ error: 'Only admins can rename admin users' });
      }
    }
    try {
      await updateUserUsername(userId, username, currentUser.userId, { reason: reason ?? null });
    } catch (err: any) {
      if (err instanceof InvalidUsernameError) return res.status(400).json({ error: err.message });
      if (err instanceof UsernameTakenError) return res.status(409).json({ error: err.message });
      throw err;
    }
  }

  // ── 이름·소속 (admin/operator 가 다른 사람 row 백필) ──
  if (displayName !== undefined || affiliation !== undefined) {
    if (currentUser.role !== 'admin') {
      const targetRole = await getUserRole(userId);
      if (targetRole === 'admin') {
        return res.status(403).json({ error: 'Only admins can modify admin users' });
      }
    }
    await updateUserProfile(userId, { displayName, affiliation });
  }

  res.json({ ok: true });
});

router.patch('/admin/users/:id/password', operatorOrAboveMiddleware, async (req, res) => {
  const userId = parseInt(req.params.id as string);
  const { password } = req.body;
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const currentUser = (req as any).user;
  if (currentUser.role !== 'admin') {
    const targetRole = await getUserRole(userId);
    if (targetRole === 'admin') {
      return res.status(403).json({ error: 'Only admins can reset admin passwords' });
    }
  }
  await resetUserPassword(userId, password);
  res.json({ ok: true });
});

router.delete('/admin/users/:id', operatorOrAboveMiddleware, async (req, res) => {
  const userId = parseInt(req.params.id as string);
  const currentUser = (req as any).user;
  if (currentUser.userId === userId) return res.status(403).json({ error: 'Cannot delete yourself' });
  if (currentUser.role !== 'admin') {
    const targetRole = await getUserRole(userId);
    if (targetRole === 'admin') {
      return res.status(403).json({ error: 'Only admins can disable admin users' });
    }
  }
  await disableUser(userId);
  const disconnectedSockets = disconnectUserSockets(userId);
  res.json({ ok: true, disconnectedSockets });
});

// ───── Metrics: Usage Heatmap ─────
router.get('/work/ledger-health', async (req, res) => {
  try {
    const userId = (req as any).user?.userId as number | undefined;
    const role = ((req as any).user?.role || 'member') as string;
    if (!userId) return res.status(401).json({ error: 'auth required' });
    if (role !== 'admin' && role !== 'operator') return res.status(403).json({ error: 'admin or operator required' });
    res.json(await getWorkLedgerHealth(Number(req.query.windowHours) || 24));
  } catch (err: any) {
    console.error('[work/ledger-health] error:', err);
    res.status(500).json({ error: err?.message || 'internal error' });
  }
});

router.get('/work/challenge-timeline', async (req, res) => {
  try {
    const userId = (req as any).user?.userId as number | undefined;
    const role = ((req as any).user?.role || 'member') as string;
    if (!userId) return res.status(401).json({ error: 'auth required' });

    const result = await getChallengeTimeline({
      userId,
      role,
      rangeHours: Number(req.query.rangeHours) || undefined,
      bucketHours: Number(req.query.bucketHours) || undefined,
      projectId: typeof req.query.projectId === 'string' ? req.query.projectId : null,
      ownerUserId: typeof req.query.userId === 'string' && req.query.userId !== 'all' ? Number(req.query.userId) : null,
      limitChallenges: Number(req.query.limit) || undefined,
    });
    res.json(result);
  } catch (err: any) {
    console.error('[work/challenge-timeline] error:', err);
    res.status(500).json({ error: err?.message || 'internal error' });
  }
});

// Returns project × day grid of REAL user turns (user messages with type:text only,
// excluding tool_result bounces and assistant intermediate tool_use blocks).
// Filtered to projects the current user owns or is a member of.
// Personal AI usage summary. Unlike the operator-only VM budget endpoint, this
// route is always scoped to the authenticated user's own sessions.
router.get('/metrics/my-ai-usage', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });
    const days = Math.max(1, Math.min(parseInt(String(req.query.days || '30'), 10) || 30, 180));

    const totals = await queryOne<{
      sessions: string;
      turns: string;
      total_tokens: string;
      cost_usd: string;
    }>(
      `SELECT COUNT(*)::text AS sessions,
              COALESCE(SUM(turn_count), 0)::text AS turns,
              COALESCE(SUM(total_tokens), 0)::text AS total_tokens,
              COALESCE(SUM(total_cost), 0)::text AS cost_usd
         FROM sessions
        WHERE user_id = $1
          AND updated_at >= NOW() - ($2 || ' days')::interval`,
      [userId, String(days)],
    );

    const daily = await query<{
      date: string;
      turns: string;
      input_tokens: string;
      output_tokens: string;
      cost_usd: string;
    }>(
      `SELECT to_char(DATE(m.created_at), 'YYYY-MM-DD') AS date,
              COUNT(*) FILTER (WHERE m.role = 'user')::text AS turns,
              COALESCE(SUM(m.input_tokens), 0)::text AS input_tokens,
              COALESCE(SUM(m.output_tokens), 0)::text AS output_tokens,
              COALESCE(SUM(CASE WHEN m.role = 'assistant' THEN NULLIF(m.metadata->'usage'->>'cost_usd', '')::numeric ELSE 0 END), 0)::text AS cost_usd
         FROM messages m
         JOIN sessions s ON s.id = m.session_id
        WHERE s.user_id = $1
          AND m.created_at >= NOW() - ($2 || ' days')::interval
        GROUP BY DATE(m.created_at)
        ORDER BY DATE(m.created_at)`,
      [userId, String(days)],
    );

    const projectDaily = await query<{
      project_id: string;
      project_name: string;
      date: string;
      turns: string;
    }>(
      `SELECT COALESCE(s.project_id, 'none') AS project_id,
              COALESCE(p.name, '프로젝트 없음') AS project_name,
              to_char(DATE(m.created_at), 'YYYY-MM-DD') AS date,
              COUNT(*)::text AS turns
         FROM messages m
         JOIN sessions s ON s.id = m.session_id
         LEFT JOIN projects p ON p.id = s.project_id
        WHERE s.user_id = $1
          AND m.role = 'user'
          AND m.created_at >= NOW() - ($2 || ' days')::interval
        GROUP BY COALESCE(s.project_id, 'none'), COALESCE(p.name, '프로젝트 없음'), DATE(m.created_at)
        ORDER BY COUNT(*) DESC`,
      [userId, String(days)],
    );

    const dates: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      dates.push(date.toISOString().slice(0, 10));
    }
    const projectMap = new Map<string, { id: string; name: string; total: number; byDate: Map<string, number> }>();
    for (const row of projectDaily) {
      const item = projectMap.get(row.project_id) || { id: row.project_id, name: row.project_name, total: 0, byDate: new Map<string, number>() };
      const turns = Number(row.turns || 0);
      item.total += turns;
      item.byDate.set(row.date, turns);
      projectMap.set(row.project_id, item);
    }
    const dailyCost = daily.reduce((sum, row) => sum + Number(row.cost_usd || 0), 0);
    const sessionCost = Number(totals?.cost_usd || 0);

    res.json({
      days,
      dates,
      totals: {
        sessions: Number(totals?.sessions || 0),
        turns: Number(totals?.turns || 0),
        totalTokens: Number(totals?.total_tokens || 0),
        costUsd: dailyCost > 0 ? dailyCost : sessionCost,
      },
      daily: daily.map((row) => ({
        date: row.date,
        turns: Number(row.turns || 0),
        inputTokens: Number(row.input_tokens || 0),
        outputTokens: Number(row.output_tokens || 0),
        costUsd: Number(row.cost_usd || 0),
      })),
      projects: Array.from(projectMap.values())
        .sort((a, b) => b.total - a.total)
        .slice(0, 12)
        .map((project) => ({ id: project.id, name: project.name, total: project.total, values: dates.map((date) => project.byDate.get(date) || 0) })),
      costBasis: dailyCost > 0 ? 'message-provider-metadata' : 'session-estimate',
      costAvailable: dailyCost > 0 || sessionCost > 0,
    });
  } catch (err: any) {
    console.error('[metrics/my-ai-usage] error:', err);
    res.status(500).json({ error: err?.message || 'internal error' });
  }
});

router.get('/metrics/usage-heatmap', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    const days = Math.max(1, Math.min(parseInt(String(req.query.days || '30'), 10) || 30, 180));
    const topN = Math.max(1, Math.min(parseInt(String(req.query.top || '20'), 10) || 20, 50));

    // 1) Per-project totals over window, filtered to accessible projects
    const totalsSql = `
      SELECT p.id, p.name,
        COUNT(*) FILTER (WHERE m.role='user' AND m.content LIKE '[{"type":"text"%') AS turns,
        COUNT(DISTINCT s.id) AS sessions,
        COUNT(DISTINCT DATE(m.created_at)) AS active_days
      FROM projects p
      JOIN sessions s ON s.project_id = p.id
      JOIN messages m ON m.session_id = s.id
      WHERE (p.archived IS NULL OR p.archived = 0)
        AND (
          p.user_id = $1
          OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $1)
        )
        AND m.created_at >= NOW() - ($2 || ' days')::interval
      GROUP BY p.id, p.name
      HAVING COUNT(*) FILTER (WHERE m.role='user' AND m.content LIKE '[{"type":"text"%') > 0
      ORDER BY turns DESC
      LIMIT $3
    `;
    const totals = await query<{ id: string; name: string; turns: string; sessions: string; active_days: string }>(
      totalsSql, [userId, String(days), topN]
    );

    if (totals.length === 0) {
      return res.json({ days, topN, dates: [], projects: [], grandTotal: 0 });
    }

    const projectIds = totals.map((t) => t.id);

    // 2) Daily breakdown for those projects
    const dailySql = `
      SELECT s.project_id AS project_id,
             to_char(DATE(m.created_at), 'YYYY-MM-DD') AS d,
             COUNT(*) FILTER (WHERE m.role='user' AND m.content LIKE '[{"type":"text"%') AS turns
      FROM sessions s
      JOIN messages m ON m.session_id = s.id
      WHERE s.project_id = ANY($1::text[])
        AND m.created_at >= NOW() - ($2 || ' days')::interval
      GROUP BY s.project_id, DATE(m.created_at)
      HAVING COUNT(*) FILTER (WHERE m.role='user' AND m.content LIKE '[{"type":"text"%') > 0
    `;
    const daily = await query<{ project_id: string; d: string; turns: string }>(
      dailySql, [projectIds, String(days)]
    );

    // 3) Build continuous date axis (days window ending today, inclusive)
    const dates: string[] = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }

    // 4) Build lookup and assemble per-project value arrays in the date order
    const lookup: Record<string, Record<string, number>> = {};
    for (const row of daily) {
      if (!lookup[row.project_id]) lookup[row.project_id] = {};
      lookup[row.project_id][row.d] = Number(row.turns);
    }

    let grandTotal = 0;
    const projects = totals.map((t) => {
      const map = lookup[t.id] || {};
      const values = dates.map((d) => map[d] || 0);
      const total = Number(t.turns);
      grandTotal += total;
      return {
        id: t.id,
        name: t.name,
        total,
        sessions: Number(t.sessions),
        activeDays: Number(t.active_days),
        values,
      };
    });

    // 5) Daily totals across ALL accessible projects (not just top N)
    const allDailySql = `
      SELECT to_char(DATE(m.created_at), 'YYYY-MM-DD') AS d,
             COUNT(*) AS turns
      FROM projects p
      JOIN sessions s ON s.project_id = p.id
      JOIN messages m ON m.session_id = s.id
      WHERE (p.archived IS NULL OR p.archived = 0)
        AND (
          p.user_id = $1
          OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $1)
        )
        AND m.created_at >= NOW() - ($2 || ' days')::interval
        AND m.role = 'user' AND m.content LIKE '[{"type":"text"%'
      GROUP BY DATE(m.created_at)
    `;
    const allDaily = await query<{ d: string; turns: string }>(allDailySql, [userId, String(days)]);
    const allDailyMap: Record<string, number> = {};
    let allTotal = 0;
    for (const row of allDaily) {
      allDailyMap[row.d] = Number(row.turns);
      allTotal += Number(row.turns);
    }
    const dailyTotals = dates.map((d) => allDailyMap[d] || 0);

    res.json({ days, topN, dates, projects, grandTotal: allTotal, dailyTotals });
  } catch (err: any) {
    console.error('[metrics/usage-heatmap] error:', err);
    res.status(500).json({ error: err?.message || 'internal error' });
  }
});

// ───── Sessions ─────


router.get('/session-attention', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) return res.status(401).json({ error: 'auth required' });
    res.json({ entries: await getUserSessionAttention(userId) });
  } catch (err: any) {
    console.error('[session-attention] get error:', err);
    res.status(500).json({ error: err?.message || 'internal error' });
  }
});

router.put('/session-attention', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) return res.status(401).json({ error: 'auth required' });
    const upsert = Array.isArray(req.body?.upsert) ? req.body.upsert : [];
    const remove = Array.isArray(req.body?.delete) ? req.body.delete : [];
    await upsertUserSessionAttention(userId, upsert.map((entry: any) => ({
      sessionId: typeof entry?.sessionId === 'string' ? entry.sessionId : '',
      sessionUpdatedAt: typeof entry?.sessionUpdatedAt === 'string' ? entry.sessionUpdatedAt : null,
      state: entry?.state,
    })));
    await deleteUserSessionAttention(userId, remove.map((entry: any) => ({
      sessionId: typeof entry?.sessionId === 'string' ? entry.sessionId : '',
      state: entry?.state,
    })));
    res.json({ ok: true });
  } catch (err: any) {
    console.error('[session-attention] put error:', err);
    res.status(500).json({ error: err?.message || 'internal error' });
  }
});



router.post('/sessions/:id/project-agent-profile/latest', async (req, res) => {
  const userId = (req as any).user?.userId;
  const role = (req as any).user?.role;
  if (!userId) return res.status(401).json({ error: 'auth required' });
  if (!config.agentFirstEnabled) return res.status(404).json({ error: 'Agent-first feature is not enabled' });

  const sessionId = req.params.id as string;
  const access = await canAccessSession(sessionId, userId, role);
  if (!access.allowed) return res.status(access.status).json({ error: access.message });
  const session = await getSession(sessionId, userId);
  if (!session?.projectId) return res.status(409).json({ error: 'Session is not attached to a Project' });

  const profile = await repinSessionProjectAgentProfile(sessionId, session.projectId);
  if (!profile) return res.status(409).json({ error: 'Project has no explicit Primary Agent profile' });
  res.json({
    ok: true,
    sessionId,
    projectId: session.projectId,
    profileVersion: profile.profileVersion,
    instructionSource: profile.instructionSource,
    displayName: profile.displayName,
    appliedFromNextTurn: true,
  });
});



router.get('/sessions/:id/process-map', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    const sessionId = req.params.id as string;
    if (userId) {
      const access = await canAccessSession(sessionId, userId, role);
      if (!access.allowed) return res.status(access.status).json({ error: access.message });
    }
    const session = await getSession(sessionId, userId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(await getSessionProcessMap({
      sessionId,
      projectId: (session as any).projectId ?? (session as any).project_id ?? null,
      title: session.name,
    }));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sessions/:id/process-map/automation-scout', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const username = (req as any).user?.username;
    const role = (req as any).user?.role;
    const sessionId = req.params.id as string;
    if (!userId) return res.status(401).json({ error: 'auth required' });
    const access = await canAccessSession(sessionId, userId, role);
    if (!access.allowed) return res.status(access.status).json({ error: access.message });
    const session = await getSession(sessionId, userId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const processMap = await getSessionProcessMap({
      sessionId,
      projectId: (session as any).projectId ?? (session as any).project_id ?? null,
      title: session.name,
    });
    const processMapSummary = (processMap.nodes || []).map((node, index) => ({
      index: index + 1,
      id: node.id,
      label: node.label,
      kind: node.kind,
      status: node.status,
      owner: node.owner,
      automationLevel: node.automationLevel,
      summary: node.summary,
      evidence: node.evidence,
    }));

    const recentRows = await getMessages(sessionId);
    const recentMessages = recentRows.slice(-12).map((message) => {
      let blocks: any[] = [];
      try { blocks = typeof message.content === 'string' ? JSON.parse(message.content) : (message.content as any); } catch { blocks = []; }
      const text = Array.isArray(blocks)
        ? blocks.map((block: any) => block.type === 'text' ? block.text : block.type === 'tool_use' ? `[tool:${block.name || block.toolUse?.name || 'unknown'}]` : '').filter(Boolean).join('\n')
        : '';
      return {
        id: message.id,
        role: message.role,
        createdAt: message.created_at,
        text: text.replace(/\s+/g, ' ').trim().slice(0, 900),
      };
    }).filter((message) => message.text);

    const promptFromClient = typeof req.body?.prompt === 'string' ? req.body.prompt.slice(0, 8000) : '';
    const selectedExecutionId = typeof req.body?.selectedExecutionId === 'string' ? req.body.selectedExecutionId : undefined;
    const task = [
      '# Automation Scout input brief',
      '',
      '## Source session',
      `- sessionId: ${sessionId}`,
      `- sessionName: ${session.name}`,
      `- projectId: ${(session as any).projectId ?? (session as any).project_id ?? 'none'}`,
      `- selectedExecutionId: ${selectedExecutionId || 'latest'}`,
      `- processMapId: ${processMap.id}`,
      `- processMapStatus: ${processMap.status}`,
      '',
      '## Process Map nodes',
      '```json',
      JSON.stringify(processMapSummary, null, 2),
      '```',
      '',
      '## Recent source-session messages',
      '```json',
      JSON.stringify(recentMessages, null, 2),
      '```',
      '',
      promptFromClient ? '## Client-selected view summary' : '',
      promptFromClient || '',
      '',
      '## Your task',
      '이 자료만으로 부족하면 부족하다고 말하되, 원 세션의 sessionId와 evidence를 근거로 자동화 후보 분석을 수행하라.',
      '반드시 다음 순서로 보고하라:',
      '1. 결론: 자동화/스킬화 가치가 있는지',
      '2. 추천 경로: skill | skill_refinement | code_command | schedule_trigger | defer 중 하나',
      '3. Automation brief: 목적, 입력, 고정 단계, 변동 단계, 사람 승인 지점, 산출물, 검증 기준, 실패/예외 사례',
      '4. 근거: Process Map node id, 메시지 id, 파일/도구 evidence를 인용',
      '5. parent가 사용자에게 물어볼 다음 질문 1개',
    ].filter(Boolean).join('\n');

    const { createPersistentWorker } = await import('../services/agent-workers.js');
    const launched = await createPersistentWorker({
      parentSessionId: sessionId,
      ownerUserId: userId,
      parentUsername: username,
      parentRole: role,
      name: 'Automation Scout',
      role: 'Process Map 자동화 후보 분석',
      instruction: [
        '너는 Tower의 Automation Scout subagent다.',
        'Process Map과 원 세션 evidence를 보고 반복 업무를 재사용 가능한 능력으로 승격할 수 있는지 분석한다.',
        '새 skill 생성, 기존 skill 수정, code command 구현, schedule 생성, 파일 수정, 커밋, 배포는 하지 않는다.',
        '반드시 node id/message id/file/tool evidence를 근거로 삼고, 근거가 부족하면 부족하다고 표시한다.',
        '결론, 추천 경로, Automation brief, 근거, parent가 사용자에게 물어볼 다음 질문을 간결히 보고한다.',
      ].join('\n'),
      goal: 'Process Map 기반 자동화/스킬화 후보 분석',
      task,
      visibility: 'sidebar',
      onComplete: 'wake',
    });
    res.json({ ok: true, ...launched });
  } catch (err: any) {
    res.status(err?.status || 500).json({ error: err?.message || 'Automation Scout launch failed' });
  }
});

// POST /sessions/spawn — L3 child-session spawn (parent → sidebar peer)
// Caller (parent) creates a new session that runs the prompt in background
// and (by default) injects its final answer back into the parent.
// See: workspace/decisions/2026-05-09-l3-session-spawn-rpc.md
router.post('/sessions/spawn', async (req, res) => {
  const userId = (req as any).user?.userId;
  const username = (req as any).user?.username;
  const role = (req as any).user?.role;
  if (!userId) return res.status(401).json({ error: 'auth required' });

  const body = req.body || {};
  const { parentSessionId, prompt, name, model, contextSummary, onComplete, engine } = body;
  const projectId: string | null | undefined = body.projectId;

  if (!parentSessionId || typeof parentSessionId !== 'string') {
    return res.status(400).json({ error: 'parentSessionId required' });
  }
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'prompt required' });
  }
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'name required' });
  }

  // Caller must have access to the parent session
  const parentAccess = await canAccessSession(parentSessionId, userId, role);
  if (!parentAccess.allowed) {
    return res.status(parentAccess.status).json({ error: parentAccess.message });
  }

  // If projectId is explicitly given (and not null), check project access
  if (typeof projectId === 'string' && projectId.length > 0) {
    const projAccess = await canCreateInProject(projectId, userId, role);
    if (!projAccess.allowed) {
      return res.status(projAccess.status).json({ error: projAccess.message });
    }
  }

  try {
    const { spawnChildSession } = await import('../services/session/spawn-rpc.js');
    const result = await spawnChildSession({
      parentSessionId,
      parentUserId: userId,
      parentUsername: username,
      parentRole: role,
      prompt,
      name: name.slice(0, 80),
      engine,
      model,
      projectId,
      contextSummary,
      onComplete,
    });
    return res.json({
      sessionId: result.sessionId,
      spawnId: result.spawnId,
      url: `/sessions/${result.sessionId}`,
    });
  } catch (err: any) {
    const status = err?.status || 500;
    return res.status(status).json({ error: err?.message || 'spawn failed', code: err?.code });
  }
});

// POST /sessions/:id/send — Phase 2: send a message into target session.
// Auto-routes to sendToSpawnedSession if `from` is the target's parent,
// else falls back to sendToSession (self-owned or admin permission).
// Body: { from: <callerSessionId>, message: string }
// Decision: workspace/decisions/2026-05-09-l3-spawn-phase2-orchestration.md
router.post('/sessions/:id/send', async (req, res) => {
  const userId = (req as any).user?.userId;
  const role = (req as any).user?.role;
  if (!userId) return res.status(401).json({ error: 'auth required' });

  const targetId = req.params.id as string;
  const { from, message } = req.body || {};
  if (!from || typeof from !== 'string') {
    return res.status(400).json({ error: '`from` (caller session id) required' });
  }
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: '`message` required' });
  }

  // Caller must have access to the from-session (= they own it or are admin)
  const fromAccess = await canAccessSession(from, userId, role);
  if (!fromAccess.allowed) {
    return res.status(fromAccess.status).json({ error: fromAccess.message });
  }

  try {
    const callerSession = await getSession(from);
    if (!callerSession) return res.status(404).json({ error: 'caller session not found' });

    const target = await getSession(targetId);
    if (!target) return res.status(404).json({ error: 'target session not found' });

    const callerName = callerSession.name || `session ${from.slice(0, 8)}`;
    const isParentSpawn = target.parentSessionId === from;

    const { sendToSpawnedSession, sendToSession } = await import(
      '../services/session/spawn-rpc.js'
    );

    if (isParentSpawn) {
      await sendToSpawnedSession({
        callerSessionId: from,
        callerSessionName: callerName,
        callerUserId: userId,
        callerRole: role,
        childSessionId: targetId,
        message,
      });
    } else {
      await sendToSession({
        callerSessionId: from,
        callerSessionName: callerName,
        callerUserId: userId,
        callerRole: role,
        targetSessionId: targetId,
        message,
      });
    }
    return res.json({ ok: true, route: isParentSpawn ? 'spawned' : 'session' });
  } catch (err: any) {
    const status = err?.status || 500;
    return res.status(status).json({ error: err?.message || 'send failed', code: err?.code });
  }
});

// GET /sessions/:id/spawned — Phase 2: list spawned children of a session.
// Returns 50 most recent children with status (running/idle/archived).
router.get('/sessions/:id/spawned', async (req, res) => {
  const userId = (req as any).user?.userId;
  const role = (req as any).user?.role;
  if (!userId) return res.status(401).json({ error: 'auth required' });

  const parentId = req.params.id as string;
  const access = await canAccessSession(parentId, userId, role);
  if (!access.allowed) return res.status(access.status).json({ error: access.message });

  try {
    const { listSpawnedSessions } = await import('../services/session/spawn-rpc.js');
    const list = await listSpawnedSessions(parentId);
    return res.json(list);
  } catch (err: any) {
    const status = err?.status || 500;
    return res.status(status).json({ error: err?.message || 'list failed', code: err?.code });
  }
});

router.patch('/sessions/:id', async (req, res) => {
  const { name, tags, favorite, totalCost, totalTokens, engineSessionId, claudeSessionId, autoNamed, cwd, visibility, modelUsed, engine } = req.body;
  const userId = (req as any).user?.userId;
  const userRole = (req as any).user?.role;

  // Session access check (owner or project member)
  if (userId) {
    const access = await canAccessSession(req.params.id as string, userId, userRole);
    if (!access.allowed) return res.status(access.status).json({ error: access.message });
  }

  // Visibility change: only session owner or admin (stricter than general access)
  if (visibility !== undefined) {
    const { queryOne: pgQueryOne } = await import('../db/pg-repo.js');
    const row = await pgQueryOne<{ user_id: number }>('SELECT user_id FROM sessions WHERE id = $1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Session not found' });
    if (userRole !== 'admin' && row.user_id !== userId) {
      return res.status(403).json({ error: 'Only session owner or admin can change visibility' });
    }
  }

  // favorite is now *per-user* (user_session_favorites table) — handled
  // separately from updateSession (which writes session-global columns).
  // 결정: workspace/decisions/2026-05-22-per-user-session-favorites.md
  if (favorite !== undefined) {
    if (!userId) return res.status(401).json({ error: 'auth required to set favorite' });
    const { setSessionFavorite } = await import('../services/session/session-manager.js');
    await setSessionFavorite(req.params.id as string, userId, !!favorite);
  }

  const updates: any = { name, tags, totalCost, totalTokens };
  if (claudeSessionId !== undefined) updates.claudeSessionId = claudeSessionId;
  if (engineSessionId !== undefined) {
    if (engine === 'pi') updates.piSessionFile = engineSessionId;
    if (engine === 'claude') updates.claudeSessionId = engineSessionId;
  }
  if (autoNamed !== undefined) updates.autoNamed = autoNamed;
  if (visibility !== undefined) updates.visibility = visibility;
  if ('label' in req.body) updates.label = req.body.label;
  if (cwd !== undefined) {
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      return res.status(400).json({ error: 'Invalid directory path' });
    }
    updates.cwd = cwd;
  }
  // modelUsed: persist the user's per-session model choice, but never store a
  // model that does not match the session engine. Right-click long-context
  // toggles are cheap PATCHes; accepting a prefixed/mismatched value here can
  // poison the next turn and leave the UI looking stuck while the engine fails.
  if (modelUsed !== undefined) {
    if (modelUsed !== null && typeof modelUsed !== 'string') {
      return res.status(400).json({ error: 'modelUsed must be a string or null' });
    }
    if (modelUsed === null) {
      updates.modelUsed = null;
    } else {
      const current = await getSession(req.params.id as string);
      if (!current) return res.status(404).json({ error: 'Session not found' });
      const targetEngine = typeof engine === 'string' ? engine : (current.engine || config.defaultEngine || 'pi');
      const normalizedModelUsed = modelUsed.trim();
      if (!normalizedModelUsed) {
        updates.modelUsed = null;
      } else if (targetEngine === 'pi') {
        updates.modelUsed = normalizePiSessionModelId(normalizedModelUsed);
      } else if (targetEngine === 'claude') {
        if (!normalizedModelUsed.startsWith('claude-')) {
          return res.status(400).json({ error: 'modelUsed does not match session engine' });
        }
        updates.modelUsed = normalizedModelUsed;
      } else if (targetEngine === 'local') {
        if (normalizedModelUsed.startsWith('claude-') || normalizedModelUsed.includes('/')) {
          return res.status(400).json({ error: 'modelUsed does not match session engine' });
        }
        updates.modelUsed = normalizedModelUsed;
      } else {
        return res.status(400).json({ error: 'engine must be one of: claude, pi, local' });
      }
    }
  }
  // engine: raw engine swap is allowed ONLY for empty sessions (lossless).
  // For sessions with real history, a raw PATCH would change the engine WITHOUT
  // rehydrating the new engine's native state → silent context loss. Those must
  // go through POST /sessions/:id/switch-engine (rehydrate + guards + audit).
  // See workspace/decisions/2026-05-19-engine-hard-switch-design.md.
  if (engine !== undefined) {
    const validEngines = ['claude', 'pi', 'local'];
    if (!validEngines.includes(engine)) {
      return res.status(400).json({ error: `engine must be one of: ${validEngines.join(', ')}` });
    }
    const current = await getSession(req.params.id as string);
    const isEngineChange = current && (current.engine ?? 'claude') !== engine;
    const hasHistory = current && ((current.turnCount ?? 0) > 0);
    if (isEngineChange && hasHistory) {
      return res.status(409).json({
        error: 'Cannot raw-swap engine on a session with history — context would be lost. Use POST /sessions/:id/switch-engine instead.',
        code: 'USE_SWITCH_ENGINE',
      });
    }
    updates.engine = engine;
  }
  await updateSession(req.params.id as string, updates);
  // Broadcast to all clients so other users see changes in real-time
  try {
    const { broadcastToAll } = await import('./ws-handler.js');
    broadcastToAll({ type: 'session_meta_update', sessionId: req.params.id, updates });
  } catch {}
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────
// Engine hard switch — POST /sessions/:id/switch-engine
//
// Same session, next turn = different engine. Source of truth = messages
// table. Caller must be the session owner or admin.
//
// Body: { toEngine: 'pi' | 'claude' | ..., targetModel?: string, reason?: string }
// 200  { ok:true, fromEngine, toEngine, atTurn, newEngineSessionId, ... }
// 200  { ok:false, error:{code:'SAME_ENGINE', ...} }        — no-op
// 400  { ok:false, error:{code:'UNSUPPORTED_TARGET', ...} } — engine off / no rehydrate
// 403  Forbidden                                            — access denied
// 404  { ok:false, error:{code:'NOT_FOUND', ...} }
// 409  { ok:false, error:{code:'RUNNING'|'PENDING_TOOL_USE'} } — boundary violated
// 500  { ok:false, error:{code:'REHYDRATE_FAILED', ...} }
//
// See: workspace/decisions/2026-05-19-engine-hard-switch-design.md
//      packages/backend/services/session/engine-switch.ts
// ─────────────────────────────────────────────────────────────────────
router.post('/sessions/:id/switch-engine', async (req, res) => {
  const sessionId = req.params.id as string;
  const userId = (req as any).user?.userId;
  const userRole = (req as any).user?.role;

  // ── Auth: owner OR admin only (stricter than canAccessSession's
  // project-member reach — engine swap is a session-altering operation,
  // not a read or even a metadata edit).
  if (userId) {
    const { queryOne: pgQueryOne } = await import('../db/pg-repo.js');
    const row = await pgQueryOne<{ user_id: number | null }>(
      'SELECT user_id FROM sessions WHERE id = $1',
      [sessionId]
    );
    if (!row) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Session not found.' } });
    if (userRole !== 'admin' && row.user_id !== userId) {
      return res.status(403).json({ error: 'Only the session owner or an admin can switch engines.' });
    }
  }

  // ── Body validation
  const { toEngine, targetModel, reason } = req.body ?? {};
  if (typeof toEngine !== 'string' || toEngine.length === 0) {
    return res.status(400).json({ error: 'toEngine is required and must be a non-empty string.' });
  }
  if (targetModel !== undefined && typeof targetModel !== 'string') {
    return res.status(400).json({ error: 'targetModel must be a string if provided.' });
  }
  if (reason !== undefined && typeof reason !== 'string') {
    return res.status(400).json({ error: 'reason must be a string if provided.' });
  }

  const result = await switchEngine(
    {
      sessionId,
      toEngine,
      ...(targetModel ? { targetModel } : {}),
      reason,
      ...(typeof userId === 'number' ? { switchedBy: userId } : {}),
    },
    {
      getSession,
      getMessages,
      getEngine,
      ensurePiHarnessSnapshot: async ({ sessionId: targetSessionId, projectId, targetModel }) => {
        const { getOrPinSessionHarnessSnapshot } = await import('../services/harness/harness-store.js');
        await getOrPinSessionHarnessSnapshot({
          sessionId: targetSessionId,
          projectId,
          requestedEngine: 'pi',
          requestedModel: targetModel,
          invocationKind: 'session',
        });
      },
      recordEngineSwitch,
      updateSession,
      saveMessage,
      generateMessageId: () => uuidv4(),
      now: () => new Date(),
    }
  );

  if (!result.ok) {
    const status = (() => {
      switch (result.error.code) {
        case 'NOT_FOUND': return 404;
        case 'SAME_ENGINE': return 200;        // idempotent — caller's intent already true
        case 'RUNNING':
        case 'PENDING_TOOL_USE': return 409;
        case 'UNSUPPORTED_TARGET': return 400;
        case 'REHYDRATE_FAILED': return 500;
      }
    })();
    return res.status(status).json(result);
  }

  // ── Broadcast so every connected client refreshes the session's engine chip.
  try {
    broadcastToAll({
      type: 'engine_switched',
      sessionId,
      fromEngine: result.fromEngine,
      toEngine: result.toEngine,
      atTurn: result.atTurn,
      systemMessageId: result.systemMessageId,
    });
    // Also bump session_meta_update so the sidebar's "last used" + engine label re-fetch.
    broadcastToAll({
      type: 'session_meta_update',
      sessionId,
      updates: { engine: result.toEngine },
    });
  } catch {}

  res.json(result);
});

const AI_COMPOSER_ASSISTANT_SENTENCE_LIMIT = 10;

// Generate one lightweight next-turn suggestion for the empty chat composer.
router.post('/ai/reply-suggestion', authMiddleware, async (req, res) => {
  const composerSettings = await getAiComposerSettings();
  if (!composerSettings.enabled) {
    return res.status(503).json({ error: 'AI composer autocomplete is temporarily disabled' });
  }
  const rawAssistantTail = typeof req.body?.assistantTail === 'string' ? req.body.assistantTail : '';
  const assistantSentences = rawAssistantTail
    .split(/(?<=[.!?。！？]|(?:다|요|죠|까|네|군|음|함))\s+|\n+/)
    .map((sentence: string) => sentence.trim())
    .filter(Boolean)
    .slice(-AI_COMPOSER_ASSISTANT_SENTENCE_LIMIT);
  const assistantTail = assistantSentences.join(' ').slice(-composerSettings.assistantContextChars);
  if (!assistantTail) {
    return res.status(400).json({ error: 'assistantTail is required' });
  }

  // Keep the exact cursor-adjacent draft, including trailing whitespace. This is
  // source text to continue, not a query to normalize.
  const draft = typeof req.body?.draft === 'string' ? req.body.draft.slice(0, 2000) : '';
  if (draft.trim() && !composerSettings.inlineDraftEnabled) {
    return res.status(204).end();
  }
  const suggestion = await runUtilityTextTask({
    model: getModelDefaults().ai_reply,
    timeoutMs: composerSettings.modelTimeoutMs,
    fallbackText: '',
    systemPrompt: [
      draft
        ? [
          'You are a writing assistant embedded inside the HUMAN USER composer. Your only job is to help the user finish the message they are already trying to write.',
          'Silently infer the user\'s intended speech act from CURRENT_USER_DRAFT: for example asking a question, correcting the assistant, requesting an action, expressing doubt, adding a condition, or clarifying a preference.',
          'Then complete that intended message naturally in the user\'s own voice, as if the user had continued typing it themselves.',
          'The draft is not a question addressed to you for an answer. Never answer it, explain it, acknowledge it, reassure the user, or switch into an assistant voice.',
          'CURRENT_USER_DRAFT is the primary source of truth. Preserve its unfinished grammar, wording, first-person perspective, politeness level, tone, and concrete purpose.',
          'Use the previous ASSISTANT text only to understand references such as 이거, 그 방식, 네가 말한 것, or what the user is reacting to. Do not summarize or continue the assistant text.',
          'Generate the most likely wording that completes the user\'s purpose, not a generally relevant next reply.',
          'Return only the shortest useful suffix inserted at <CURSOR/> inside the same user message. Never repeat, paraphrase, or rewrite existing draft text.',
          'Before output, mentally verify: Draft + suffix must read as one continuous message written entirely by the human user.',
        ].join(' ')
        : 'Infer one natural next message that this specific user is most likely to want to send after reading the recent conversation.',
      draft
        ? 'Prefer completing the draft\'s apparent communicative purpose over introducing any new idea, advice, or answer.'
        : 'Use both the user\'s latest question and the assistant\'s answer; preserve the user\'s tone and current goal.',
      draft
        ? 'If the draft already forms a complete thought or no confident continuation exists, return an empty string.'
        : 'Look for a concrete unresolved curiosity, useful follow-up, clarification, comparison, or next action suggested by the answer.',
      'Do not default to generic continuation phrases such as 계속 진행하자, 이어가자, or tell me more.',
      'Only suggest continuation when the assistant explicitly offered a concrete next step, and name that step specifically.',
      'Return exactly one short message in the conversation language, without quotes, labels, or explanation.',
      'Never approve destructive, external, financial, credential, deployment, deletion, or irreversible actions; return an empty string for those.',
      'If no specific and natural next message is clear, return an empty string.',
      'Keep the message under 80 Korean characters or 16 English words.',
    ].join(' '),
    prompt: draft
      ? [
        '<CONVERSATION_HISTORY>',
        `<ASSISTANT>${assistantTail}</ASSISTANT>`,
        '</CONVERSATION_HISTORY>',
        '<CURRENT_USER_DRAFT>',
        draft,
        '<CURSOR/>',
        '</CURRENT_USER_DRAFT>',
        'Infer what the human user is trying to say, then finish that same user message at <CURSOR/>. Output the suffix alone.',
      ].join('\n')
      : `Assistant: ${assistantTail}\n\nMost likely next user message:`,
  });
  // Full-message suggestions may be trimmed, but inline suffixes must preserve
  // meaningful leading whitespace (`문장을` + ` 이어서`). Remove only wrapper
  // quotes/newlines from suffix output, never spaces adjacent to the cursor.
  const cleanedMessage = suggestion.trim().replace(/^['"]|['"]$/g, '');
  const cleanedSuffix = suggestion
    .replace(/^[\r\n]+|[\r\n]+$/g, '')
    .replace(/^(["'])([\s\S]*)\1$/, '$2');
  const awkwardGeneric = /^(계속|다음)\s*(직업|작업)?\s*(이어가자|진행하자|진행해줘)[.!]?$/;
  const safeSuggestion = awkwardGeneric.test(cleanedMessage) ? '' : cleanedMessage;
  // Draft completion asks for a suffix, but tolerate providers that still echo the
  // full draft. The previous strict startsWith-only contract silently discarded
  // normal suffix-only responses, making inline completion appear broken.
  const suffix = draft
    ? (cleanedSuffix.startsWith(draft) ? cleanedSuffix.slice(draft.length) : cleanedSuffix)
    : '';
  res.json({ suggestion: draft ? '' : safeSuggestion, suffix });
});

// Auto-name session based on first messages
router.post('/sessions/:id/auto-name', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (userId) {
      const access = await canAccessSession(req.params.id as string, userId, role);
      if (!access.allowed) return res.status(access.status).json({ error: access.message });
    }
    const messages = await getMessages(req.params.id as string);
    const userMsg = messages.find((m) => m.role === 'user');
    const assistantMsg = messages.find((m) => m.role === 'assistant');
    if (!userMsg || !assistantMsg) {
      return res.status(400).json({ error: 'Need at least one user and assistant message' });
    }

    const userText = extractTextFromContent(userMsg.content);
    const assistantText = extractTextFromContent(assistantMsg.content);

    const name = await generateSessionName(userText, assistantText);
    await updateSession(req.params.id as string, { name, autoNamed: 1 } as any);
    res.json({ ok: true, name });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Summarize session
router.post('/sessions/:id/summarize', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (userId) {
      const access = await canAccessSession(req.params.id as string, userId, role);
      if (!access.allowed) return res.status(access.status).json({ error: access.message });
    }
    const messages = await getMessages(req.params.id as string);
    if (messages.length === 0) {
      return res.status(400).json({ error: 'No messages to summarize' });
    }

    // Last 20 messages, preserving user/assistant conversation order
    const recent = messages.slice(-20);
    const messagesText = recent
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => {
        const text = extractTextFromContent(m.content).trim();
        if (!text) return null;
        const label = m.role === 'user' ? 'User' : 'AI';
        return `${label}: ${text.slice(0, 400)}`;
      })
      .filter(Boolean)
      .join('\n');

    console.log('[summarize] sessionId:', req.params.id as string);
    console.log('[summarize] messages count:', messages.length);
    console.log('[summarize] filtered count:', recent.filter((m) => m.role === 'user' || m.role === 'assistant').length);
    console.log('[summarize] messagesText length:', messagesText.length);
    console.log('[summarize] messagesText preview:', messagesText.slice(0, 300));

    const summary = await generateSummary(messagesText);

    // Get current session to read turnCount
    const session = await getSession(req.params.id as string);
    const turnCount = session?.turnCount ?? 0;
    await updateSession(req.params.id as string, { summary, summaryAtTurn: turnCount });
    res.json({ ok: true, summary, summaryAtTurn: turnCount });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ───── Session Backlinks (Level 1 — shared-files) ─────
// GET /api/sessions/:id/related-by-files?limit=10
// Returns other sessions (any user) the caller can access, that edited the same files.
// See: workspace/decisions/2026-04-21-session-backlinks-level1.md
//      workspace/decisions/2026-05-20-session-backlinks-cross-user.md
router.get('/sessions/:id/related-by-files', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = ((req as any).user?.role ?? 'member') as string;
    const sessionId = req.params.id as string;

    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const session = await getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Access control on the *target* session uses Tower's standard rule:
    // owner / project member / internal share / admin / operator. The
    // candidate (result-row) sessions get the same filter inside the
    // service layer — see session-backlinks.ts.
    const access = await canAccessSession(sessionId, userId, role);
    if (!access.allowed) return res.status(access.status).json({ error: access.message });

    // Parse limit (1-20). Design doc caps at 10 for UI; allow up to 20 for debugging.
    const rawLimit = parseInt(String(req.query.limit ?? '10'), 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(20, rawLimit)) : 10;

    // Always key by Tower's sessions.id (works across engines). The Claude UUID
    // is a secondary key used only to reach rows in ~/.claude/memory.db.
    const result = await getRelatedSessionsByFiles(
      session.id,
      session.claudeSessionId ?? null,
      userId,
      role,
      limit,
    );
    res.json(result);
  } catch (error: any) {
    console.error('[api] related-by-files failed:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch related sessions' });
  }
});

// ───── Session Touched Files (sidebar session files panel) ─────
// GET /api/sessions/:id/touched-files?limit=10
// Returns user-facing files this session has edited, most recent first.
// Powers the sessions-tab "이 세션의 파일" panel. Backend allows up to 50 for debugging.
// See: workspace/decisions/2026-05-22-sidebar-session-files-panel.md
router.get('/sessions/:id/touched-files', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = ((req as any).user?.role ?? 'member') as string;
    const sessionId = req.params.id as string;

    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const session = await getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Same access rule as backlinks: owner / project-member / share / admin.
    const access = await canAccessSession(sessionId, userId, role);
    if (!access.allowed) return res.status(access.status).json({ error: access.message });

    const rawLimit = parseInt(String(req.query.limit ?? '10'), 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(50, rawLimit)) : 10;

    const result = await getTouchedFiles(session.id, limit);
    res.json(result);
  } catch (error: any) {
    console.error('[api] touched-files failed:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch touched files' });
  }
});

// ───── Turn file checkpoint restore ─────
async function checkpointRequestContext(req: any, res: any, sessionId: string) {
  const userId = req.user?.userId as number | undefined;
  const role = String(req.user?.role || 'member');
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return null; }
  if (role === 'viewer' || role === 'guest') { res.status(403).json({ error: 'Checkpoint restore requires write access' }); return null; }
  const access = await canAccessSession(sessionId, userId, role);
  if (!access.allowed) { res.status(access.status).json({ error: access.message }); return null; }
  const session = await getSession(sessionId);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return null; }
  if (!session.cwd) { res.status(409).json({ error: 'Session project root is unavailable' }); return null; }
  return { userId, role, session, projectRoot: session.cwd };
}

router.get('/sessions/:id/turns/:turnId/checkpoint', async (req, res) => {
  try {
    const ctx = await checkpointRequestContext(req, res, req.params.id as string); if (!ctx) return;
    const checkpoint = await getTurnCheckpoint({ rootTurnId: req.params.turnId as string, sessionId: req.params.id as string });
    if (!checkpoint) return res.status(404).json({ error: 'Checkpoint not found' });
    const changes = await loadCheckpointFileChanges(checkpoint.id);
    res.json({ ...checkpoint, changes: changes.map((c) => ({ filePath: c.filePath, beforeExists: c.before.exists, afterExists: c.after.exists, beforeSha256: c.before.sha256, afterSha256: c.after.sha256 })) });
  } catch (error: any) { res.status(500).json({ error: error.message || 'Failed to load checkpoint' }); }
});

router.post('/checkpoints/:checkpointId/restore-preview', async (req, res) => {
  try {
    const owner = await getCheckpointOwner(req.params.checkpointId as string);
    if (!owner) return res.status(404).json({ error: 'Checkpoint not found' });
    const ctx = await checkpointRequestContext(req, res, owner.sessionId); if (!ctx) return;
    const preview = await previewCheckpointRestore({ checkpointId: req.params.checkpointId as string, projectRoot: ctx.projectRoot, requestedBy: ctx.userId, paths: Array.isArray(req.body?.paths) ? req.body.paths : undefined });
    res.json({ ...preview, coverage: owner.coverage });
  } catch (error: any) {
    const status = error.message === 'checkpoint_paths_not_found' ? 400 : 500;
    res.status(status).json({ error: error.message || 'Failed to preview checkpoint restore' });
  }
});

router.post('/checkpoints/:checkpointId/restore', async (req, res) => {
  try {
    const owner = await getCheckpointOwner(req.params.checkpointId as string);
    if (!owner) return res.status(404).json({ error: 'Checkpoint not found' });
    const ctx = await checkpointRequestContext(req, res, owner.sessionId); if (!ctx) return;
    if (req.body?.confirmed !== true) return res.status(400).json({ error: 'checkpoint_restore_confirmation_required' });
    if (typeof req.body?.previewHash !== 'string' || !req.body.previewHash) return res.status(400).json({ error: 'checkpoint_preview_hash_required' });
    const result = await applyConfirmedCheckpointRestore({ checkpointId: req.params.checkpointId as string, projectRoot: ctx.projectRoot, requestedBy: ctx.userId, paths: Array.isArray(req.body?.paths) ? req.body.paths : undefined, previewHash: req.body.previewHash, confirmed: true });
    res.json(result);
  } catch (error: any) {
    const status = error.message === 'checkpoint_restore_conflict' || error.message === 'checkpoint_preview_stale' ? 409 : error.message === 'checkpoint_paths_not_found' ? 400 : 500;
    res.status(status).json({ error: error.message || 'Failed to restore checkpoint' });
  }
});

// ───── Project-scoped Recent Files (sidebar fallback panel) ─────
// GET /api/sessions/:id/project-recent-files?limit=20
// Returns files recently edited by *other* sessions in the same project.
// Used as fallback in the Sidebar sessions-tab file panel when the active
// session's own working set is empty (0 user-facing files).
// If the session has no project_id, returns { files:[], projectMissing:true }.
// Decision: workspace/decisions/2026-05-22-sidebar-session-files-panel.md
router.get('/sessions/:id/project-recent-files', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = ((req as any).user?.role ?? 'member') as string;
    const sessionId = req.params.id as string;

    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const session = await getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Same access rule as touched-files: owner / project-member / share / admin.
    const access = await canAccessSession(sessionId, userId, role);
    if (!access.allowed) return res.status(access.status).json({ error: access.message });

    const rawLimit = parseInt(String(req.query.limit ?? '20'), 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(50, rawLimit)) : 20;

    const result = await getProjectRecentFiles(session.id, limit);
    res.json(result);
  } catch (error: any) {
    console.error('[api] project-recent-files failed:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch project recent files' });
  }
});

async function hideSessionFromSidebar(req: any, res: any) {
  const userId = req.user?.userId;
  const role = req.user?.role;
  const sessionId = req.params.id as string;
  if (userId) {
    const access = await canDeleteSession(sessionId, userId, role);
    if (!access.allowed) return res.status(access.status).json({ error: access.message });
  }
  // Snapshot the session BEFORE hiding so we know its project/owner
  // for scoped broadcast (other tabs/members need to drop it from sidebar).
  const snapshot = await getSession(sessionId);
  if (!snapshot) return res.status(404).json({ error: 'Session not found' });

  // Empty sessions have no recoverable value and only add noise to History.
  // On hide, delete them outright; non-empty sessions are reversible archives.
  const messageCount = await queryOne<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM messages WHERE session_id = $1',
    [sessionId],
  );
  const isEmpty = Number(messageCount?.count ?? 0) === 0;
  const agentWorker = await queryOne<{ id: string }>(
    'SELECT id FROM agent_workers WHERE backing_session_id = $1 LIMIT 1',
    [sessionId],
  );
  const ok = isEmpty && !agentWorker ? await permanentlyDeleteSession(sessionId) : await deleteSession(sessionId);
  if (!ok) return res.status(404).json({ error: 'Session not found' });
  if (agentWorker) {
    await execute(
      `UPDATE agent_workers
          SET status = 'archived',
              updated_at = NOW(),
              last_heartbeat_at = NOW()
        WHERE id = $1`,
      [agentWorker.id],
    );
    await execute(
      `INSERT INTO agent_events
         (id, kind, worker_id, owner_user_id, project_id, parent_session_id, session_id, metadata)
       VALUES (gen_random_uuid()::text, 'worker_archived', $1, $2, $3, $4, $5, $6::jsonb)`,
      [
        agentWorker.id,
        userId ?? null,
        snapshot.projectId ?? null,
        snapshot.parentSessionId ?? null,
        sessionId,
        JSON.stringify({ via: 'session_hide' }),
      ],
    );
  }
  res.json({ ok: true, hidden: true, permanentlyDeleted: false, agentWorkerArchived: !!agentWorker });

  // Realtime: tell every connected client that this session left the active list.
  // Keep the event name for backward compatibility with older frontends.
  broadcastToAll({
    type: 'session_deleted',
    sessionId,
    projectId: snapshot?.projectId ?? null,
  });
}

// Hide/archive a session. This is intentionally reversible via History restore.
// DELETE is kept as a compatibility alias for older clients; permanent deletion
// lives at DELETE /api/sessions/:id/permanent.
router.post('/sessions/:id/hide', hideSessionFromSidebar);
router.delete('/sessions/:id', hideSessionFromSidebar);

router.get('/sessions/:id/branch-source', async (req, res) => {
  const userId = (req as any).user?.userId;
  const role = (req as any).user?.role;
  if (!userId) return res.status(401).json({ error: 'auth required' });
  const child = await getSession(req.params.id as string);
  if (!child?.parentSessionId || !child.sourceMessageId || child.label !== 'conversation_branch') {
    return res.status(404).json({ error: 'conversation_branch_source_not_found' });
  }
  const access = await canAccessSession(child.parentSessionId, userId, role);
  if (!access.allowed) return res.status(access.status).json({ error: access.message });
  const source = await queryOne<{ short_code: string | null; short_id: string | null; name: string }>(
    `SELECT s.short_code, m.short_id, s.name
       FROM sessions s
       LEFT JOIN messages m ON m.id = $2 AND m.session_id = s.id
      WHERE s.id = $1`,
    [child.parentSessionId, child.sourceMessageId],
  );
  if (!source) return res.status(404).json({ error: 'conversation_branch_source_not_found' });
  return res.json({
    sessionId: child.parentSessionId,
    sessionKey: source.short_code || child.parentSessionId,
    sessionName: source.name,
    messageShortId: source.short_id,
    hash: source.short_id ? `#m-${source.short_id}` : undefined,
  });
});

router.post('/sessions/:id/messages/:messageId/branch', async (req, res) => {
  if (!config.turnRewindEnabled) return res.status(404).json({ error: 'conversation_branch_unavailable' });
  const userId = (req as any).user?.userId;
  const role = (req as any).user?.role;
  const sourceSessionId = req.params.id as string;
  const sourceMessageId = req.params.messageId as string;
  const mode = req.body?.mode as ConversationBranchMode;
  if (!userId) return res.status(401).json({ error: 'auth required' });
  if (role === 'viewer' || role === 'guest') return res.status(403).json({ error: 'write access required' });
  if (mode !== 'edit_and_resend' && mode !== 'clone_through') {
    return res.status(400).json({ error: 'conversation_branch_mode_invalid' });
  }
  const access = await canAccessSession(sourceSessionId, userId, role);
  if (!access.allowed) return res.status(access.status).json({ error: access.message });
  try {
    const restoreRequest = req.body?.restore;
    let validatedRestore: { checkpointId: string; previewHash: string; paths?: string[]; projectRoot: string } | null = null;
    if (restoreRequest) {
      const checkpointId = String(restoreRequest.checkpointId || '');
      const previewHash = String(restoreRequest.previewHash || '');
      const paths = Array.isArray(restoreRequest.paths) ? restoreRequest.paths.map(String) : undefined;
      if (!checkpointId || !previewHash || restoreRequest.confirmed !== true) {
        return res.status(400).json({ error: 'conversation_branch_restore_confirmation_required' });
      }
      const owner = await getCheckpointOwner(checkpointId);
      if (!owner || owner.sessionId !== sourceSessionId || owner.rootTurnId !== sourceMessageId) {
        return res.status(400).json({ error: 'conversation_branch_checkpoint_mismatch' });
      }
      const sourceSession = await getSession(sourceSessionId);
      if (!sourceSession?.cwd) return res.status(409).json({ error: 'conversation_branch_project_root_unavailable' });
      validatedRestore = { checkpointId, previewHash, paths, projectRoot: sourceSession.cwd };
    }

    const result = await branchConversation({ sourceSessionId, sourceMessageId, actorUserId: userId, mode });
    let restoredPaths: string[] | undefined;
    if (validatedRestore) {
      try {
        const restored = await applyConfirmedCheckpointRestore({
          checkpointId: validatedRestore.checkpointId,
          projectRoot: validatedRestore.projectRoot,
          requestedBy: userId,
          paths: validatedRestore.paths,
          previewHash: validatedRestore.previewHash,
          confirmed: true,
        });
        restoredPaths = restored.restoredPaths;
      } catch (restoreError: any) {
        broadcastToUser(userId, { type: 'session_created', session: result.session });
        const restoreStatus = restoreError?.message === 'checkpoint_restore_conflict' || restoreError?.message === 'checkpoint_preview_stale' ? 409 : 500;
        return res.status(restoreStatus).json({
          error: restoreError?.message || 'conversation_branch_restore_failed',
          session: result.session,
          draft: result.draft,
          branchCreated: true,
        });
      }
    }
    broadcastToUser(userId, { type: 'session_created', session: result.session });
    return res.json({ ...result, restoredPaths });
  } catch (err: any) {
    const status = err?.status || 500;
    if (status >= 500) console.error('[api] conversation branch failed:', err);
    return res.status(status).json({ error: err?.message || 'conversation branch failed' });
  }
});

router.post('/sessions/:id/messages/:messageId/rewind-replay', async (req, res) => {
  if (!config.turnRewindEnabled) return res.status(404).json({ error: 'conversation_rewind_unavailable' });
  const userId = (req as any).user?.userId;
  const role = (req as any).user?.role;
  const sourceSessionId = req.params.id as string;
  const sourceMessageId = req.params.messageId as string;
  if (!userId) return res.status(401).json({ error: 'auth required' });
  if (role === 'viewer' || role === 'guest') return res.status(403).json({ error: 'write access required' });
  const access = await canAccessSession(sourceSessionId, userId, role);
  if (!access.allowed) return res.status(access.status).json({ error: access.message });
  try {
    const result = await rewindConversationForReplay({ sourceSessionId, sourceMessageId });
    return res.json(result);
  } catch (err: any) {
    const status = err?.status || 500;
    if (status >= 500) console.error('[api] conversation rewind failed:', err);
    return res.status(status).json({ error: err?.message || 'conversation rewind failed' });
  }
});

// POST /api/sessions/:id/clone — duplicate a session (DB rows + .jsonl file)
// See: workspace/decisions/2026-04-28-session-clone.md
router.post('/sessions/:id/clone', async (req, res) => {
  const userId = (req as any).user?.userId;
  const role = (req as any).user?.role;
  const sourceId = req.params.id as string;
  // Permission: anyone with read access can clone (the clone's owner becomes the actor).
  if (userId) {
    const access = await canAccessSession(sourceId, userId, role);
    if (!access.allowed) return res.status(access.status).json({ error: access.message });
  }
  try {
    const cloned = await cloneSession(sourceId, userId ?? null);
    res.json({ session: cloned });
    // Realtime: notify the actor's other tabs so the sidebar refreshes.
    if (userId) {
      broadcastToUser(userId, { type: 'session_cloned', session: cloned, sourceId });
    }
  } catch (err: any) {
    if (err?.message === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Source session not found' });
    }
    if (err?.message === 'IN_PROGRESS') {
      return res.status(409).json({
        error: '응답이 진행 중인 세션은 복제할 수 없습니다. 응답이 끝난 뒤 다시 시도해주세요.',
      });
    }
    console.error('[api] session clone failed:', err);
    res.status(500).json({ error: err?.message || 'Failed to clone session' });
  }
});

// Claude native sessions (read-only). Multi-account aware: returns rows
// across all enabled config_dirs, each tagged with which account it lives in.
router.get('/claude-sessions', async (_req, res) => {
  res.json(await scanClaudeNativeSessions());
});

// ───── Search (PG tsvector with smart ranking) ─────
// Query params:
//   q                required, min length 2
//   limit            1-50, default 20 — base per-section cap
//   memoryLimit      optional explicit cap for session_memory_cards
//   sessionLimit     optional explicit cap for session hits
//   messageLimit     optional explicit cap for message hits
//   deep             "1" | "true" → larger per-section search for research
//   includeArchived  "1" | "true" → include archived sessions + their messages
//   projectId        UUID → 1.3× ranking boost for sessions in that project
router.get('/search', async (req, res) => {
  const q = (req.query.q as string || '').trim();
  if (!q || q.length < 2) {
    return res.json([]);
  }
  const userId = (req as any).user?.userId;
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
  const memoryLimit = req.query.memoryLimit ? Math.min(parseInt(req.query.memoryLimit as string) || 0, 50) : undefined;
  const sessionLimit = req.query.sessionLimit ? Math.min(parseInt(req.query.sessionLimit as string) || 0, 50) : undefined;
  const messageLimit = req.query.messageLimit ? Math.min(parseInt(req.query.messageLimit as string) || 0, 50) : undefined;
  const role = (req as any).user?.role;
  const raw = String(req.query.includeArchived || '').toLowerCase();
  const includeArchived = raw === '1' || raw === 'true';
  const rawDeep = String(req.query.deep || '').toLowerCase();
  const deep = rawDeep === '1' || rawDeep === 'true';
  const projectIdRaw = (req.query.projectId as string | undefined) || null;
  // Only pass plausibly-valid UUIDs — anything else is noise we shouldn't blend
  // into the SQL comparator.
  const currentProjectId = projectIdRaw && /^[0-9a-f-]{8,}$/i.test(projectIdRaw)
    ? projectIdRaw
    : null;
  const results = await search(q, {
    userId,
    role,
    limit,
    memoryLimit,
    sessionLimit,
    messageLimit,
    includeArchived,
    deep,
    currentProjectId,
  });
  res.json(results);
});



// ───── Inline Edit (Phase 1: md / txt / html) ─────
// POST /api/files/inline-edit — rewrite a selected portion of a file using AI.
// Decision: workspace/decisions/2026-05-05-preview-inline-edit.md
//
// This endpoint ONLY produces a candidate replacement. The frontend shows a
// diff and the user explicitly clicks "Apply" → /api/files/write to commit.
// No file mutation happens here.
const inlineEditLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30, // per user per minute
  message: { error: 'Too many inline-edit requests. Slow down a bit.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => {
    const userId = req.user?.userId;
    if (userId) return `inline-edit:user:${userId}`;

    // express-rate-limit v8 requires ipKeyGenerator() for IPv6-safe fallback
    // keys; using raw req.ip can let IPv6 users rotate addresses around limits.
    const ip = req.ip || req.connection.remoteAddress || '0.0.0.0';
    return `inline-edit:ip:${ipKeyGenerator(ip)}`;
  },
});

router.post('/files/inline-edit', inlineEditLimiter, async (req, res) => {
  try {
    if (!config.inlineEditEnabled) {
      return res.status(404).json({ error: 'Inline edit feature is not enabled' });
    }

    const {
      path: rawPath,
      selection,
      beforeContext,
      afterContext,
      instruction,
      model,
      sessionId,
      selectionKind,
      editMode,
    } = req.body || {};

    if (!rawPath) return res.status(400).json({ error: 'path required' });
    const filePath = expandHome(String(rawPath));

    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    const userRoot = userId ? await getUserAllowedPath(userId) : config.workspaceRoot;

    if (isDotfileDenied(filePath)) {
      return res.status(403).json({ error: 'Access denied: system path' });
    }
    if (!(await isPathAllowedByCoarseRootOrAcl(filePath, userRoot, userId, role))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (userId && !(await isPathAccessible(filePath, userId, role))) {
      return res.status(403).json({ error: 'Access denied: not a member of the project owning this file' });
    }
    if (userId && !(await isPathWritableByRole(filePath, userId, role || 'member'))) {
      return res.status(403).json({ error: 'Access denied: this folder is read-only for your role' });
    }

    const result = await runInlineEdit({
      selection: typeof selection === 'string' ? selection : '',
      beforeContext: typeof beforeContext === 'string' ? beforeContext : '',
      afterContext: typeof afterContext === 'string' ? afterContext : '',
      instruction: typeof instruction === 'string' ? instruction : '',
      model: typeof model === 'string' ? model : undefined,
      selectionKind: selectionKind === 'html' ? 'html' : 'text',
      editMode:
        editMode === 'insertBefore' || editMode === 'insertAfter'
          ? editMode
          : 'replace',
    });

    // Capture current mtime so the frontend can detect concurrent edits
    // before calling /api/files/write.
    const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;

    appendInlineEditAudit({
      sessionId: typeof sessionId === 'string' ? sessionId : null,
      userId: userId ?? null,
      role: role ?? null,
      path: filePath,
      instruction: typeof instruction === 'string' ? instruction : '',
      selectionLen: typeof selection === 'string' ? selection.length : 0,
      replacementLen: result.replacement.length,
      model: result.model,
      applied: false, // turns true only after the user calls /api/files/write
      durationMs: result.durationMs,
    });

    res.json({
      replacement: result.replacement,
      model: result.model,
      durationMs: result.durationMs,
      mtimeMs: stat ? stat.mtimeMs : null,
    });
  } catch (err: any) {
    const msg = err?.message || 'inline-edit failed';
    // Validation errors → 400; everything else → 500.
    const status = /too long|empty|required/i.test(msg) ? 400 : 500;
    // Always log the full stack — stdout/stderr is captured by the dev runner
    // and is the fastest way to triage 500s during dogfood.
    console.error('[inline-edit] failed:', err);
    const body: any = { error: msg };
    // In dev, surface the stack so the client can show it without a server-log dive.
    if (process.env.NODE_ENV !== 'production' && err?.stack) {
      body.stack = String(err.stack).split('\n').slice(0, 6).join('\n');
    }
    res.status(status).json(body);
  }
});

// ───── File Upload ─────
// Max files per upload request. Folder drops can fan out — pick a number that
// covers a typical project sub-folder without letting a single request OOM
// the server (memoryStorage holds every buffer in RAM).
const UPLOAD_MAX_FILES = 500;
// Wrap multer to catch errors (e.g. file size limit) and return JSON instead of HTML
const handleProjectMulterUpload = (req: any, res: any, next: any) => {
  projectUpload.array('files', UPLOAD_MAX_FILES)(req, res, (err: any) => {
    if (err) {
      void cleanupProjectUploadStaging(req);
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `File too large (max ${UPLOAD_MAX_SIZE / 1024 / 1024}MB)` });
      }
      if (err.code === 'LIMIT_FILE_COUNT') {
        return res.status(413).json({ error: `Too many files (max ${UPLOAD_MAX_FILES})` });
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ error: `Unexpected field "${err.field}" (expected "files")` });
      }
      return res.status(400).json({ error: err.message || 'Upload error', code: err.code });
    }
    next();
  });
};
router.post('/files/upload', handleProjectMulterUpload, withProjectUploadCleanup, async (req, res) => {
  try {
    const targetDir = req.body.targetDir as string;
    if (!targetDir) return res.status(400).json({ error: 'targetDir required' });
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    const userRoot = userId ? await getUserAllowedPath(userId) : config.workspaceRoot;
    if (!isPathSafe(targetDir, userRoot)) return res.status(403).json({ error: 'Access denied: target directory outside allowed path' });
    if (isDotfileDenied(targetDir)) return res.status(403).json({ error: 'Access denied: system path' });
    // 2026-05-02: enforce role-based write policy on the target dir.
    // Members can only upload into their own project folders. uploads/ is
    // admin/operator only; for member uploads, frontend must pass a
    // project-scoped targetDir (e.g. workspace/projects/<p>/uploads/).
    if (userId && !(await isPathWritableByRole(targetDir, userId, role || 'member'))) {
      return res.status(403).json({ error: 'Access denied: cannot upload to this folder. Use your project folder.' });
    }

    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) return res.status(400).json({ error: 'No files provided' });

    // relativePaths: parallel array to files. Each entry is the desired path
    // relative to targetDir (e.g. "src/index.ts" for a folder drop, or just
    // "logo.png" for a flat file drop). The frontend sends this as a single
    // JSON-encoded string field (sent BEFORE the file parts to avoid multer's
    // "Unexpected field" rejection on text-between-files). For backward compat
    // with any older client we also accept an array or a single string.
    let relativePaths: string[] = [];
    const rawRel = req.body.relativePaths;
    if (Array.isArray(rawRel)) {
      relativePaths = rawRel as string[];
    } else if (typeof rawRel === 'string') {
      const trimmed = rawRel.trim();
      if (trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            relativePaths = parsed.map((s) => String(s));
          }
        } catch {
          // Fall through — treat as single legacy string
          relativePaths = [rawRel];
        }
      } else {
        relativePaths = [rawRel];
      }
    }

    const results: { name: string; path: string; error?: string }[] = [];
    const savedPaths: string[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      // Resolve effective relative path. Strip leading slashes; reject any
      // segment that would let the path escape targetDir.
      let rel = (relativePaths[i] || file.originalname).replace(/^\/+/, '');
      const segments = rel.split('/').filter((s) => s.length > 0);
      if (segments.length === 0 || segments.includes('..')) {
        results.push({ name: file.originalname, path: '', error: 'Invalid path' });
        continue;
      }
      rel = segments.join('/');

      const filePath = path.join(targetDir, rel);
      if (!isPathSafe(filePath, userRoot)) {
        results.push({ name: rel, path: '', error: 'Access denied' });
        continue;
      }
      try {
        const workerAuthority = userId ? await resolveWorkerFileAuthorityForHostPath(filePath) : undefined;
        if (workerAuthority) {
          await uploadWorkerProjectFile({ authority: workerAuthority, actorUserId: userId, sourcePath: file.path, sizeBytes: file.size });
          mirrorWorkerProjectMutation(workerAuthority, { kind: 'upload', hostPath: filePath, sourcePath: file.path });
        } else {
          await copyStagedProjectFile(file.path, filePath);
        }
        results.push({ name: rel, path: filePath });
        savedPaths.push(filePath);
      } catch (err: any) {
        results.push({ name: rel, path: '', error: err.message });
      }
    }

    // Invalidate tree cache for upload target. Uploads intentionally do NOT
    // auto-commit to git: uploaded customer/source materials are workspace
    // inputs, not code history. See workspace/decisions/2026-06-08-large-folder-resumable-upload.md.
    invalidateTreeCache(targetDir);
    appendFileTransferEventSafe({
      actorUserId: userId,
      direction: 'upload',
      transferKind: files.length > 1 ? 'multipart' : 'single',
      status: savedPaths.length > 0 ? 'completed' : 'failed',
      paths: savedPaths.length > 0 ? savedPaths : [targetDir],
      itemCount: savedPaths.length,
      totalBytes: files.filter((_, index) => !results[index]?.error).reduce((sum, file) => sum + file.size, 0),
      metadata: { requestedCount: files.length, failedCount: results.filter((result) => result.error).length },
    });

    const storageAuthority = userId && await resolveWorkerFileAuthorityForHostPath(targetDir) ? 'worker' : 'host';
    res.json({ results, storageAuthority });
  } catch (error: any) {
    console.error('[upload] unexpected error:', error);
    res.status(500).json({ error: error.message || 'Internal upload error' });
  }
});

// ───── Chat File Upload (saves to .temp-uploads/ first, finalized on send) ─────
router.post('/files/chat-upload', upload.array('files', UPLOAD_MAX_FILES), async (req, res) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) return res.status(400).json({ error: 'No files provided' });

    // Determine temp upload directory. Project-scoped uploads should live inside
    // the project from the first byte, not in workspace/.temp-uploads, so image
    // previews and later AI [file: ...] references stay within the project ACL.
    // Global temp remains only as admin/operator fallback when no projectId exists.
    const projectId = req.body?.projectId;
    let uploadDir = path.join(TEMP_UPLOADS_DIR, 'global');
    if (projectId) {
      try {
        const { getProject } = await import('../services/pm/project-manager.js');
        const project = await getProject(projectId);
        if (project?.rootPath) {
          uploadDir = path.join(project.rootPath, 'uploads', '.temp');
        }
      } catch {}
    }
    fs.mkdirSync(uploadDir, { recursive: true });

    const results: { name: string; path: string; size?: number; mimeType?: string; error?: string }[] = [];

    for (const file of files) {
      // Deduplicate: add timestamp prefix to avoid collisions
      // Allow Unicode letters/numbers (Korean, Japanese, etc.) while blocking path-unsafe chars
      const safeName = `${Date.now()}-${file.originalname.replace(/[^\p{L}\p{N}._-]/gu, '_')}`;
      const filePath = path.join(uploadDir, safeName);
      try {
        writeFileBinary(filePath, file.buffer, uploadDir);
        results.push({ name: file.originalname, path: filePath, size: file.size, mimeType: file.mimetype });
      } catch (err: any) {
        results.push({ name: file.originalname, path: '', error: err.message });
      }
    }

    res.json({ results });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ───── Finalize temp uploads: move from .temp-uploads/ to permanent uploads/ ─────
router.post('/files/finalize-uploads', async (req, res) => {
  try {
    const { tempPaths, projectId } = req.body;
    if (!Array.isArray(tempPaths) || tempPaths.length === 0) {
      return res.status(400).json({ error: 'tempPaths array required' });
    }

    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;

    // Determine permanent upload directory.
    // 2026-05-02: Members MUST supply a projectId (so the upload lands under
    // workspace/projects/<p>/uploads/). The legacy global UPLOADS_DIR is
    // admin/operator-only because it's outside any project's ACL boundary.
    let permanentDir = UPLOADS_DIR;
    if (projectId) {
      try {
        const { getProject } = await import('../services/pm/project-manager.js');
        const project = await getProject(projectId);
        if (project?.rootPath) {
          permanentDir = path.join(project.rootPath, 'uploads');
          fs.mkdirSync(permanentDir, { recursive: true });
        }
      } catch {}
    }
    if (userId && !(await isPathWritableByRole(permanentDir, userId, role || 'member'))) {
      return res.status(403).json({
        error: 'Access denied: cannot finalize uploads to this folder. Pass a projectId you are a member of.',
      });
    }

    const projectTempDir = path.join(permanentDir, '.temp');
    const allowedTempRoots = [path.resolve(TEMP_UPLOADS_DIR), path.resolve(projectTempDir)];
    const isAllowedTempPath = (candidate: string) => {
      const resolvedCandidate = path.resolve(candidate);
      return allowedTempRoots.some((root) => resolvedCandidate.startsWith(root + path.sep));
    };

    const results: { tempPath: string; newPath: string; error?: string }[] = [];

    for (const tempPath of tempPaths) {
      // Security: ensure tempPath is either the legacy global temp upload path
      // or this project's uploads/.temp path.
      const resolved = path.resolve(tempPath);
      if (!isAllowedTempPath(resolved)) {
        results.push({ tempPath, newPath: '', error: 'Invalid temp path' });
        continue;
      }
      if (!fs.existsSync(resolved)) {
        results.push({ tempPath, newPath: '', error: 'File not found' });
        continue;
      }
      const fileName = path.basename(resolved);
      const newPath = path.join(permanentDir, fileName);
      try {
        fs.renameSync(resolved, newPath);
        results.push({ tempPath, newPath });
      } catch {
        // Cross-device fallback: copy + delete
        try {
          fs.copyFileSync(resolved, newPath);
          fs.unlinkSync(resolved);
          results.push({ tempPath, newPath });
        } catch (e2: any) {
          results.push({ tempPath, newPath: '', error: e2.message });
        }
      }
    }

    res.json({ results });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ───── Delete a single temp upload ─────
router.delete('/files/temp-upload', async (req, res) => {
  try {
    const tempPath = (req.query.path as string) || req.body?.path;
    if (!tempPath) return res.status(400).json({ error: 'path required' });

    const resolved = path.resolve(tempPath);
    const legacyTempRoot = path.resolve(TEMP_UPLOADS_DIR);
    const workspaceProjectRoot = path.resolve(path.join(config.workspaceRoot, 'projects'));
    const isLegacyTemp = resolved.startsWith(legacyTempRoot + path.sep);
    const marker = `${path.sep}uploads${path.sep}.temp${path.sep}`;
    const isProjectUploadTemp = resolved.startsWith(workspaceProjectRoot + path.sep) && resolved.includes(marker);
    if (!isLegacyTemp && !isProjectUploadTemp) {
      return res.status(403).json({ error: 'Not a temp upload path' });
    }
    if (isProjectUploadTemp) {
      const permanentUploadDir = resolved.slice(0, resolved.indexOf(marker) + `${path.sep}uploads`.length);
      const userId = (req as any).user?.userId;
      const role = (req as any).user?.role;
      if (userId && !(await isPathWritableByRole(permanentUploadDir, userId, role || 'member'))) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }
    if (fs.existsSync(resolved)) {
      fs.unlinkSync(resolved);
    }
    res.json({ ok: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ───── File Management (create / mkdir / delete / rename) ─────
//
// 2026-05-02 (workspace-root-isolation):
// - Dotfile / system paths blocked for ALL roles
// ───── ZIP Download ─────

// Single directory → ZIP
router.get('/files/download-zip', async (req, res) => {
  try {
    const dirPath = req.query.path as string;
    if (!dirPath) return res.status(400).json({ error: 'path required' });
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    const userRoot = userId ? await getUserAllowedPath(userId) : config.workspaceRoot;
    if (!isPathSafe(dirPath, userRoot)) return res.status(403).json({ error: 'Access denied' });
    if (userId && !(await isPathAccessible(dirPath, userId, role))) return res.status(403).json({ error: 'Access denied' });

    const resolved = path.resolve(dirPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return res.status(404).json({ error: 'Directory not found' });
    }

    const dirName = path.basename(resolved);
    appendFileTransferEventSafe({ actorUserId: userId, direction: 'download', transferKind: 'folder', paths: [resolved], itemCount: 1 });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', contentDispositionHeader('attachment', `${dirName}.zip`));

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err: Error) => res.status(500).json({ error: err.message }));
    archive.pipe(res);
    archive.directory(resolved, dirName);
    await archive.finalize();
  } catch (error: any) {
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// Multiple selected paths → ZIP
router.get('/files/download-zip-selected', async (req, res) => {
  try {
    const rawPaths = req.query.paths as string;
    if (!rawPaths) return res.status(400).json({ error: 'paths required' });
    let paths: string[];
    try { paths = JSON.parse(rawPaths); } catch { return res.status(400).json({ error: 'Invalid paths JSON' }); }
    if (!Array.isArray(paths) || paths.length === 0) return res.status(400).json({ error: 'Empty paths' });

    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    const userRoot = userId ? await getUserAllowedPath(userId) : config.workspaceRoot;

    for (const p of paths) {
      if (!isPathSafe(p, userRoot)) return res.status(403).json({ error: `Access denied: ${p}` });
      if (userId && !(await isPathAccessible(p, userId, role))) return res.status(403).json({ error: `Access denied: ${p}` });
    }

    const existingPaths = paths.map((value) => path.resolve(value)).filter((value) => fs.existsSync(value));
    const totalBytes = existingPaths.reduce((sum, value) => {
      const stat = fs.statSync(value);
      return stat.isFile() ? sum + stat.size : sum;
    }, 0);
    appendFileTransferEventSafe({
      actorUserId: userId,
      direction: 'download',
      transferKind: 'selection',
      paths: existingPaths,
      itemCount: existingPaths.length,
      totalBytes,
    });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', contentDispositionHeader('attachment', 'selected-files.zip'));

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err: Error) => res.status(500).json({ error: err.message }));
    archive.pipe(res);

    for (const p of paths) {
      const resolved = path.resolve(p);
      if (!fs.existsSync(resolved)) continue;
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        archive.directory(resolved, path.basename(resolved));
      } else {
        archive.file(resolved, { name: path.basename(resolved) });
      }
    }
    await archive.finalize();
  } catch (error: any) {
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// ───── Secure Input (.env writer) ─────
router.post('/env', (req, res) => {
  try {
    const { target, entries } = req.body as {
      target?: string;
      entries: { key: string; value: string }[];
    };
    if (!entries || !Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ error: 'entries required' });
    }

    // Validate key names (prevent injection)
    for (const e of entries) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.key)) {
        return res.status(400).json({ error: `Invalid key name: ${e.key}` });
      }
    }

    // Resolve target path — only allow .env files within known directories
    const fileName = target || '.env';
    if (!fileName.startsWith('.env')) {
      return res.status(400).json({ error: 'Target must be a .env file' });
    }
    const envPath = path.resolve(process.cwd(), fileName);

    // Read existing content
    let content = '';
    try {
      content = fs.readFileSync(envPath, 'utf-8');
    } catch {
      // File doesn't exist yet — will be created
    }

    // Parse existing lines
    const lines = content.split('\n');
    const existingKeys = new Map<string, number>();
    lines.forEach((line, i) => {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
      if (match) existingKeys.set(match[1], i);
    });

    // Update or append
    for (const { key, value } of entries) {
      const newLine = `${key}=${value}`;
      if (existingKeys.has(key)) {
        lines[existingKeys.get(key)!] = newLine;
      } else {
        // Append (ensure newline before if needed)
        if (lines.length > 0 && lines[lines.length - 1] !== '') {
          lines.push(newLine);
        } else {
          lines.push(newLine);
        }
      }
    }

    fs.writeFileSync(envPath, lines.join('\n'));
    res.json({ ok: true, saved: entries.length, path: envPath });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ───── Pins ─────
router.get('/pins', async (req, res) => {
  const userId = (req as any).user?.userId;
  res.json(await getPins(userId));
});

router.post('/pins', async (req, res) => {
  const { title, filePath, fileType } = req.body;
  if (!title || !filePath) return res.status(400).json({ error: 'title and filePath required' });
  const userId = (req as any).user?.userId;
  const pin = await createPin(title, filePath, fileType || 'markdown', userId);
  res.json(pin);
});

router.patch('/pins/:id', async (req, res) => {
  const { title, sortOrder } = req.body;
  const userId = (req as any).user?.userId;
  await updatePin(parseInt(req.params.id as string), { title, sortOrder }, userId);
  res.json({ ok: true });
});

router.delete('/pins/:id', async (req, res) => {
  const userId = (req as any).user?.userId;
  await deletePin(parseInt(req.params.id as string), userId);
  res.json({ ok: true });
});

router.post('/pins/reorder', async (req, res) => {
  const { orderedIds } = req.body;
  if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds array required' });
  const userId = (req as any).user?.userId;
  await reorderPins(orderedIds, userId);
  res.json({ ok: true });
});

// ───── DOCX → PDF conversion (LibreOffice headless) ─────
router.get('/files/docx-pdf', async (req, res) => {
  try {
    const filePath = expandHome(req.query.path as string);
    if (!filePath) return res.status(400).json({ error: 'path required' });
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    const userRoot = userId ? await getUserAllowedPath(userId) : config.workspaceRoot;
    if (!isPathSafe(filePath, userRoot)) return res.status(403).json({ error: 'Access denied' });
    if (userId) {
      const pathOk = await isPathAccessible(filePath, userId, role);
      if (!pathOk) return res.status(403).json({ error: 'Access denied: project path' });
    }

    const ext = filePath.split('.').pop()?.toLowerCase();
    if (ext !== 'docx' && ext !== 'doc') {
      return res.status(400).json({ error: 'Only .docx/.doc files supported' });
    }

    // Check source file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Cache directory: /tmp/tower-docx-cache/
    const cacheDir = path.join(os.tmpdir(), 'tower-docx-cache');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

    // Cache key: hash of absolute path + mtime + backend boot ID.
    // Boot ID invalidates cache on PM2 restart — see BACKEND_BOOT_ID comment
    // at top of file (2026-05-16 한글 폰트 사고 후속).
    const stat = fs.statSync(filePath);
    const crypto = await import('crypto');
    const hash = crypto.createHash('md5')
      .update(filePath + ':' + stat.mtimeMs + ':' + BACKEND_BOOT_ID)
      .digest('hex');
    const cachedPdf = path.join(cacheDir, `${hash}.pdf`);

    // Return cached if exists
    if (fs.existsSync(cachedPdf)) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', contentDispositionHeader('inline', pdfPreviewName(filePath)));
      const stream = fs.createReadStream(cachedPdf);
      stream.pipe(res);
      return;
    }

    // Convert with LibreOffice
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    // LibreOffice needs a unique user profile for concurrent calls
    const profileDir = path.join(os.tmpdir(), `lo-profile-${hash}`);

    try {
      await execFileAsync('libreoffice', [
        '--headless',
        '--norestore',
        `-env:UserInstallation=file://${profileDir}`,
        '--convert-to', 'pdf',
        '--outdir', cacheDir,
        filePath,
      ], { timeout: 30000 });

      // LibreOffice outputs with original filename but .pdf extension
      const baseName = path.basename(filePath).replace(/\.docx?$/i, '.pdf');
      const outputPdf = path.join(cacheDir, baseName);

      // Rename to our cache key
      if (fs.existsSync(outputPdf) && outputPdf !== cachedPdf) {
        fs.renameSync(outputPdf, cachedPdf);
      }

      if (!fs.existsSync(cachedPdf)) {
        return res.status(500).json({ error: 'PDF conversion failed' });
      }

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', contentDispositionHeader('inline', pdfPreviewName(filePath)));
      const stream = fs.createReadStream(cachedPdf);
      stream.pipe(res);
    } finally {
      // Cleanup temp profile
      fs.rm(profileDir, { recursive: true, force: true }, () => {});
    }
  } catch (error: any) {
    console.error('[docx-pdf] conversion error:', error.message);
    res.status(500).json({ error: 'PDF conversion failed: ' + error.message });
  }
});

// ───── Office document → HTML conversion (LibreOffice headless) ─────
// Used as a fast, web-native reading view for Korean office documents. PDF
// preview remains available when exact pagination/layout matters.
const OFFICE_HTML_EXTENSIONS = new Set(['docx', 'doc', 'hwp', 'hwpx']);

function rewriteOfficeHtmlAssetLinks(html: string, assetBase: string, token: string): string {
  const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : '';
  return html.replace(/\b(src|href)=(['"])(?![a-z][a-z0-9+.-]*:|\/|#)([^'"]+)\2/gi, (_match, attr: string, quote: string, rawUrl: string) => {
    const [assetName, suffix = ''] = String(rawUrl).split(/([?#].*)/, 2);
    if (!assetName || assetName.includes('/')) return `${attr}=${quote}${rawUrl}${quote}`;
    return `${attr}=${quote}${assetBase}${encodeURIComponent(assetName)}${tokenQuery}${suffix}${quote}`;
  });
}

function injectOfficeHtmlChrome(html: string): string {
  const viewport = '<meta name="viewport" content="width=device-width, initial-scale=1">';
  const style = `<style>
    html, body { margin: 0; padding: 0; background: #f8fafc; color: #111827; }
    body { box-sizing: border-box; max-width: 980px; margin: 0 auto; padding: 32px 40px; font-family: "Noto Sans CJK KR", "Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif; line-height: 1.6; }
    img, table { max-width: 100%; }
    table { border-collapse: collapse; }
    @media (max-width: 720px) { body { padding: 20px 16px; } }
  </style>`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (match) => `${match}${viewport}${style}`);
  }
  return `<!doctype html><html><head>${viewport}${style}</head><body>${html}</body></html>`;
}

async function assertOfficePreviewAccess(req: any, filePath: string) {
  const userId = req.user?.userId;
  const role = req.user?.role;
  const userRoot = userId ? await getUserAllowedPath(userId) : config.workspaceRoot;
  if (!isPathSafe(filePath, userRoot)) throw Object.assign(new Error('Access denied'), { statusCode: 403 });
  if (userId) {
    const pathOk = await isPathAccessible(filePath, userId, role);
    if (!pathOk) throw Object.assign(new Error('Access denied: project path'), { statusCode: 403 });
  }
}

router.get('/files/office-html', async (req, res) => {
  try {
    const filePath = expandHome(req.query.path as string);
    if (!filePath) return res.status(400).json({ error: 'path required' });
    await assertOfficePreviewAccess(req as any, filePath);

    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    if (!OFFICE_HTML_EXTENSIONS.has(ext)) {
      return res.status(400).json({ error: 'Only .docx/.doc/.hwp/.hwpx files supported' });
    }
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

    const cacheRoot = path.join(os.tmpdir(), 'tower-office-html-cache');
    if (!fs.existsSync(cacheRoot)) fs.mkdirSync(cacheRoot, { recursive: true });

    const stat = fs.statSync(filePath);
    const crypto = await import('crypto');
    const hash = crypto.createHash('md5')
      .update(filePath + ':' + stat.mtimeMs + ':' + BACKEND_BOOT_ID + ':html')
      .digest('hex');
    const outDir = path.join(cacheRoot, hash);
    const cachedHtml = path.join(outDir, 'index.html');

    if (!fs.existsSync(cachedHtml)) {
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.mkdirSync(outDir, { recursive: true });

      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);
      const profileDir = path.join(os.tmpdir(), `lo-html-profile-${hash}`);

      try {
        await execFileAsync('libreoffice', [
          '--headless',
          '--norestore',
          `-env:UserInstallation=file://${profileDir}`,
          '--convert-to', 'html',
          '--outdir', outDir,
          filePath,
        ], { timeout: 30000 });

        const htmlFiles = fs.readdirSync(outDir).filter((name) => name.toLowerCase().endsWith('.html') || name.toLowerCase().endsWith('.htm'));
        const sourceHtml = htmlFiles.find((name) => name === path.basename(filePath).replace(/\.[^.]+$/i, '.html')) || htmlFiles[0];
        if (!sourceHtml) return res.status(500).json({ error: 'HTML conversion failed' });

        const htmlPath = path.join(outDir, sourceHtml);
        if (htmlPath !== cachedHtml) fs.renameSync(htmlPath, cachedHtml);
      } finally {
        fs.rm(profileDir, { recursive: true, force: true }, () => {});
      }
    }

    const rawHtml = fs.readFileSync(cachedHtml, 'utf-8');
    const assetBase = `/api/files/office-html-asset/${encodeURIComponent(hash)}/`;
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const htmlWithAssets = rewriteOfficeHtmlAssetLinks(rawHtml, assetBase, token);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.send(injectOfficeHtmlChrome(htmlWithAssets));
  } catch (error: any) {
    console.error('[office-html] conversion error:', error.message);
    res.status(error.statusCode || 500).json({ error: 'HTML conversion failed: ' + error.message });
  }
});

router.get('/files/office-html-asset/:hash/:asset', async (req, res) => {
  try {
    const hash = String(req.params.hash || '');
    const asset = String(req.params.asset || '');
    if (!/^[a-f0-9]{32}$/.test(hash) || !asset || asset !== path.basename(asset)) {
      return res.status(400).json({ error: 'Invalid asset' });
    }
    const assetPath = path.join(os.tmpdir(), 'tower-office-html-cache', hash, asset);
    if (!fs.existsSync(assetPath)) return res.status(404).json({ error: 'Asset not found' });
    const ext = path.extname(asset).slice(1).toLowerCase();
    const assetTypes: Record<string, string> = {
      css: 'text/css; charset=utf-8',
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
    };
    res.setHeader('Content-Type', assetTypes[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(assetPath).pipe(res);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ───── Office document → PDF conversion (LibreOffice headless) ─────
// Supports .pptx/.ppt (Impress filter), .hwp/.hwpx (H2Orestart → Writer filter).
// Historical route `/files/pptx-pdf` kept for backward compat.
const OFFICE_PDF_FILTERS: Record<string, string> = {
  pptx: 'pdf:impress_pdf_Export',
  ppt: 'pdf:impress_pdf_Export',
  hwp: 'pdf:writer_pdf_Export',
  hwpx: 'pdf:writer_pdf_Export',
};
router.get('/files/pptx-pdf', async (req, res) => {
  try {
    const filePath = expandHome(req.query.path as string);
    if (!filePath) return res.status(400).json({ error: 'path required' });
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    const userRoot = userId ? await getUserAllowedPath(userId) : config.workspaceRoot;
    if (!isPathSafe(filePath, userRoot)) return res.status(403).json({ error: 'Access denied' });
    if (userId) {
      const pathOk = await isPathAccessible(filePath, userId, role);
      if (!pathOk) return res.status(403).json({ error: 'Access denied: project path' });
    }

    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const filterSpec = OFFICE_PDF_FILTERS[ext];
    if (!filterSpec) {
      return res.status(400).json({ error: 'Only .pptx/.ppt/.hwp/.hwpx files supported' });
    }

    // Check source file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Cache directory: /tmp/tower-pptx-cache/ (name retained for cache continuity)
    const cacheDir = path.join(os.tmpdir(), 'tower-pptx-cache');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

    // Cache key: hash of absolute path + mtime + backend boot ID.
    // See BACKEND_BOOT_ID comment at top of file (2026-05-16).
    const stat = fs.statSync(filePath);
    const crypto = await import('crypto');
    const hash = crypto.createHash('md5')
      .update(filePath + ':' + stat.mtimeMs + ':' + BACKEND_BOOT_ID)
      .digest('hex');
    const cachedPdf = path.join(cacheDir, `${hash}.pdf`);

    // Return cached if exists
    if (fs.existsSync(cachedPdf)) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', contentDispositionHeader('inline', pdfPreviewName(filePath)));
      const stream = fs.createReadStream(cachedPdf);
      stream.pipe(res);
      return;
    }

    // Convert with LibreOffice
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    // LibreOffice needs a unique user profile for concurrent calls
    const profileDir = path.join(os.tmpdir(), `lo-profile-${hash}`);

    try {
      // HWP timeout is longer — H2Orestart Java-based import is slower
      const timeoutMs = (ext === 'hwp' || ext === 'hwpx') ? 120000 : 60000;
      await execFileAsync('libreoffice', [
        '--headless',
        '--norestore',
        `-env:UserInstallation=file://${profileDir}`,
        '--convert-to', filterSpec,
        '--outdir', cacheDir,
        filePath,
      ], { timeout: timeoutMs });

      // LibreOffice outputs with original filename but .pdf extension
      const baseName = path.basename(filePath).replace(/\.(pptx?|hwpx?)$/i, '.pdf');
      const outputPdf = path.join(cacheDir, baseName);

      // Rename to our cache key
      if (fs.existsSync(outputPdf) && outputPdf !== cachedPdf) {
        fs.renameSync(outputPdf, cachedPdf);
      }

      if (!fs.existsSync(cachedPdf)) {
        return res.status(500).json({ error: 'PDF conversion failed' });
      }

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', contentDispositionHeader('inline', pdfPreviewName(filePath)));
      const stream = fs.createReadStream(cachedPdf);
      stream.pipe(res);
    } finally {
      // Cleanup temp profile
      fs.rm(profileDir, { recursive: true, force: true }, () => {});
    }
  } catch (error: any) {
    console.error('[office-pdf] conversion error:', error.message);
    res.status(500).json({ error: 'PDF conversion failed: ' + error.message });
  }
});

// ───── File thumbnail preview (PDF / Office first page) ─────
router.get('/files/thumbnail', async (req, res) => {
  try {
    const filePath = expandHome(req.query.path as string);
    const readable = await assertReadableFileForPreview(req, filePath);
    if (!readable.ok) return res.status(readable.status).json({ error: readable.error });

    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    if (!['pdf', 'pptx', 'ppt', 'docx', 'doc', 'hwp', 'hwpx'].includes(ext)) {
      return res.status(400).json({ error: 'Thumbnail unsupported for this file type' });
    }

    const stat = fs.statSync(filePath);
    const crypto = await import('crypto');
    const hash = crypto.createHash('md5')
      .update(filePath + ':' + stat.mtimeMs + ':' + BACKEND_BOOT_ID)
      .digest('hex');
    const cacheDir = path.join(os.tmpdir(), 'tower-file-thumbnail-cache');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    const cachedPng = path.join(cacheDir, `${hash}.png`);

    if (!fs.existsSync(cachedPng)) {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);
      let sourcePdf = filePath;
      let cleanupDir: string | null = null;

      if (ext !== 'pdf') {
        const officeCacheDir = path.join(os.tmpdir(), 'tower-file-thumbnail-office');
        if (!fs.existsSync(officeCacheDir)) fs.mkdirSync(officeCacheDir, { recursive: true });
        cleanupDir = path.join(os.tmpdir(), `lo-profile-thumb-${hash}`);
        const filterSpec = ext === 'pptx' || ext === 'ppt'
          ? 'pdf:impress_pdf_Export'
          : 'pdf:writer_pdf_Export';
        await execFileAsync('libreoffice', [
          '--headless',
          '--norestore',
          `-env:UserInstallation=file://${cleanupDir}`,
          '--convert-to', filterSpec,
          '--outdir', officeCacheDir,
          filePath,
        ], { timeout: (ext === 'hwp' || ext === 'hwpx') ? 120000 : 60000 });
        const converted = path.join(officeCacheDir, path.basename(filePath).replace(/\.(pptx?|docx?|hwpx?)$/i, '.pdf'));
        if (!fs.existsSync(converted)) return res.status(500).json({ error: 'Thumbnail conversion failed' });
        sourcePdf = converted;
      }

      const prefix = path.join(cacheDir, hash);
      try {
        await execFileAsync('pdftoppm', ['-png', '-singlefile', '-f', '1', '-l', '1', '-r', '96', sourcePdf, prefix], { timeout: 30000 });
        const rendered = `${prefix}.png`;
        if (!fs.existsSync(rendered)) return res.status(500).json({ error: 'Thumbnail render failed' });
        if (rendered !== cachedPng) fs.renameSync(rendered, cachedPng);
      } finally {
        if (cleanupDir) fs.rm(cleanupDir, { recursive: true, force: true }, () => {});
      }
    }

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const stream = fs.createReadStream(cachedPng);
    stream.pipe(res);
    stream.on('error', () => res.status(500).json({ error: 'Thumbnail read failed' }));
  } catch (error: any) {
    console.error('[file-thumbnail] error:', error.message);
    res.status(500).json({ error: 'Thumbnail failed: ' + error.message });
  }
});

function parseCadBBox(value: unknown): { minX: number; minY: number; maxX: number; maxY: number } | undefined {
  if (!value) return undefined;
  const parts = String(value).split(',').map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return undefined;
  const [minX, minY, maxX, maxY] = parts;
  if (maxX <= minX || maxY <= minY) return undefined;
  return { minX, minY, maxX, maxY };
}

// ───── CAD drawing metadata / structure ─────
router.get('/files/cad-metadata', async (req, res) => {
  try {
    if (!isCadRenderEnabled()) {
      return res.status(501).json({ error: 'CAD preview is not enabled on this Tower instance' });
    }
    const filePath = expandHome(req.query.path as string);
    const readable = await assertReadableFileForPreview(req, filePath);
    if (!readable.ok) return res.status(readable.status).json({ error: readable.error });

    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.dxf') return res.status(400).json({ error: 'CAD metadata currently supports .dxf files only' });

    const metadata = await inspectCadMetadata({ cwd: path.dirname(filePath), path: filePath });
    res.json(metadata);
  } catch (error: any) {
    console.error('[cad-metadata] error:', error.message);
    res.status(500).json({ error: 'CAD metadata failed: ' + error.message });
  }
});

// ───── CAD drawing → PNG preview ─────
router.get('/files/cad-preview', async (req, res) => {
  try {
    if (!isCadRenderEnabled()) {
      return res.status(501).json({ error: 'CAD preview is not enabled on this Tower instance' });
    }
    const filePath = expandHome(req.query.path as string);
    if (!filePath) return res.status(400).json({ error: 'path required' });
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    const userRoot = userId ? await getUserAllowedPath(userId) : config.workspaceRoot;
    if (!isPathSafe(filePath, userRoot)) return res.status(403).json({ error: 'Access denied' });
    if (userId) {
      const pathOk = await isPathAccessible(filePath, userId, role);
      if (!pathOk) return res.status(403).json({ error: 'Access denied: project path' });
    }
    if (isDotfileDenied(filePath)) return res.status(403).json({ error: 'Access denied: system path' });

    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.dxf' && ext !== '.dwg') {
      return res.status(400).json({ error: 'Only .dxf/.dwg files supported' });
    }
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

    const parseDimension = (value: unknown, fallback: number) => {
      const parsed = parseInt(String(value || ''), 10);
      if (!Number.isFinite(parsed)) return fallback;
      return Math.min(6000, Math.max(600, parsed));
    };
    const width = parseDimension(req.query.width, 2400);
    const height = parseDimension(req.query.height, 1800);
    const background = req.query.background === 'black' || req.query.background === 'transparent' ? req.query.background : 'white';
    const monochrome = req.query.monochrome === 'true';
    const bbox = parseCadBBox(req.query.bbox);

    const preferAsync = req.query.async === 'true';
    if (preferAsync) {
      const renderStatus = await startCadRenderIfNeeded({
        cwd: path.dirname(filePath),
        path: filePath,
        width,
        height,
        background,
        monochrome,
        bbox,
      });
      if (!renderStatus.ready) {
        const statusCode = renderStatus.error ? 500 : 202;
        return res.status(statusCode).json({
          status: renderStatus.error ? 'error' : 'rendering',
          error: renderStatus.error,
          renderer: renderStatus.renderer,
          width: renderStatus.image.width,
          height: renderStatus.image.height,
        });
      }
    }

    const rendered = await renderCadToCachedImage({
      cwd: path.dirname(filePath),
      path: filePath,
      width,
      height,
      background,
      monochrome,
      bbox,
    });

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', contentDispositionHeader('inline', path.basename(filePath).replace(/\.[^.]+$/i, '.png')));
    res.setHeader('X-Tower-CAD-Renderer', rendered.renderer);
    res.setHeader('X-Tower-CAD-Cache', rendered.cacheHit ? 'hit' : 'miss');
    const stream = fs.createReadStream(rendered.image.path);
    stream.pipe(res);
    stream.on('error', () => res.status(500).json({ error: 'CAD preview image read failed' }));
  } catch (error: any) {
    console.error('[cad-preview] render error:', error.message);
    res.status(500).json({ error: 'CAD preview failed: ' + error.message });
  }
});

// ───── CAD Workbench QA (beta) ─────
router.post('/files/cad-qa', async (req, res) => {
  try {
    if (!isCadRenderEnabled()) {
      return res.status(501).json({ error: 'CAD Workbench is not enabled on this Tower instance' });
    }
    if (!(config.towerRole === 'full' || process.env.CAD_WORKBENCH_BETA === 'true')) {
      return res.status(404).json({ error: 'CAD Workbench beta is not enabled' });
    }

    const filePath = expandHome(req.body?.path as string);
    const readable = await assertReadableFileForPreview(req, filePath);
    if (!readable.ok) return res.status(readable.status).json({ error: readable.error });

    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.dxf') {
      return res.status(400).json({ error: 'CAD Workbench beta currently supports .dxf only. DWG requires a separate conversion/renderer decision.' });
    }

    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    const projectsRoot = path.resolve(path.join(config.workspaceRoot, 'projects'));
    const resolvedFile = path.resolve(filePath);
    if (!resolvedFile.startsWith(projectsRoot + path.sep)) {
      return res.status(400).json({ error: 'CAD Workbench outputs must stay inside a Tower project' });
    }
    const relFromProjects = path.relative(projectsRoot, resolvedFile);
    const projectSlug = relFromProjects.split(path.sep)[0];
    const projectRoot = path.join(projectsRoot, projectSlug);
    const workCadRoot = path.join(projectRoot, 'work', 'cad');
    if (isDotfileDenied(workCadRoot)) return res.status(403).json({ error: 'Access denied: system path' });
    if (userId && !(await isPathWritableByRole(workCadRoot, userId, role || 'member'))) {
      return res.status(403).json({ error: 'Access denied: cannot write CAD Workbench artifacts in this project' });
    }

    const safeBase = path.basename(filePath, ext).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'drawing';
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const jobDir = path.join(workCadRoot, `${safeBase}-qa-${stamp}`);
    await fsPromises.mkdir(jobDir, { recursive: true });

    const cliPath = path.resolve(process.cwd(), 'packages/backend/cad-workbench/cad_workbench.py');
    const { execFile } = await import('child_process');
    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile('python3', [cliPath, 'qa', filePath, '--out-dir', jobDir, '--width', '2400', '--height', '1800'], { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          const err = new Error(stderr || stdout || error.message) as Error & { stdout?: string; stderr?: string };
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
          return;
        }
        resolve({ stdout, stderr });
      });
    });

    const qaPath = path.join(jobDir, 'qa.json');
    const qa = JSON.parse(await fsPromises.readFile(qaPath, 'utf-8'));
    res.json({
      ok: true,
      renderer: qa?.renderer ?? null,
      status: qa?.status ?? null,
      warnings: qa?.warnings ?? [],
      artifacts: {
        dir: jobDir,
        qa: qaPath,
        source: path.join(jobDir, 'source.dxf'),
        previewFull: path.join(jobDir, 'preview.full.png'),
        previewContent: path.join(jobDir, 'preview.content.png'),
        aiBrief: path.join(jobDir, 'ai-brief.md'),
        textIndex: path.join(jobDir, 'text-index.json'),
        layerSummary: path.join(jobDir, 'layer-summary.json'),
        blockIndex: path.join(jobDir, 'block-index.json'),
        candidateReport: path.join(jobDir, 'candidate-report.json'),
        cadModel: path.join(jobDir, 'cad-model.json'),
        cadGeometryManifest: path.join(jobDir, 'cad-geometry', 'manifest.json'),
        cadGeometryOverview: path.join(jobDir, 'cad-geometry', 'overview.json'),
        cadGeometryUnsupportedSummary: path.join(jobDir, 'cad-geometry', 'unsupported-summary.json'),
        candidateReportMd: path.join(jobDir, 'candidate-report.md'),
        rfqIntake: path.join(jobDir, 'rfq-intake.md'),
      },
      qa,
      stdout: result.stdout,
    });
  } catch (error: any) {
    console.error('[cad-workbench-qa] error:', error.message);
    res.status(500).json({ error: 'CAD Workbench QA failed: ' + error.message, stderr: error.stderr });
  }
});

// ───── File Serve (for pin iframe) ─────
router.get('/files/serve', async (req, res) => {
  try {
    // Expand `~/...` for portable AI-emitted paths.
    // Decision: workspace/decisions/2026-05-03-path-portability.md
    const filePath = expandHome(req.query.path as string);
    if (!filePath) return res.status(400).json({ error: 'path required' });
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;

    // Chat attachment thumbnails are served before finalize-uploads moves them
    // from project uploads/.temp/ to uploads/. Legacy global .temp-uploads remains
    // for admin/operator sessions without project context. These directories stay
    // hidden from file browsing/tooling, but authenticated users need narrow
    // read-only preview for the exact temp files they just uploaded.
    const resolvedServePath = path.resolve(filePath);
    const legacyTempRoot = path.resolve(TEMP_UPLOADS_DIR);
    const workspaceProjectRoot = path.resolve(path.join(config.workspaceRoot, 'projects'));
    const projectTempMarker = `${path.sep}uploads${path.sep}.temp${path.sep}`;
    const isTempUploadPreview = resolvedServePath.startsWith(legacyTempRoot + path.sep)
      || (resolvedServePath.startsWith(workspaceProjectRoot + path.sep) && resolvedServePath.includes(projectTempMarker));

    // 2026-05-02: dotfile/system path always blocked (admin uses ssh), except
    // the narrow chat temp-upload preview case above.
    if (!isTempUploadPreview && isDotfileDenied(filePath)) {
      return res.status(403).json({ error: 'Access denied: system path' });
    }

    // Use project-level access check (handles external project roots like /tower/uploads/)
    // Falls back to workspace root path safety for non-project paths
    if (userId && !isTempUploadPreview) {
      const pathOk = await isPathAccessible(filePath, userId, role);
      if (!pathOk) {
        // Last resort: check basic path safety against user's allowed root.
        // For non-privileged roles, the path-safe check alone isn't enough —
        // it would allow them to read workspace root direct files. Require
        // both the user-allowed-path AND privileged role for fallback.
        const userRoot = await getUserAllowedPath(userId);
        if (!isPathSafe(filePath, userRoot) || !isPrivilegedRole(role)) {
          return res.status(403).json({ error: 'Access denied' });
        }
      }
    } else {
      if (!isPathSafe(filePath, config.workspaceRoot)) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const isDownload = req.query.download === '1';
    const fileName = path.basename(filePath);
    const ext = filePath.split('.').pop()?.toLowerCase();
    const binaryTypes: Record<string, string> = {
      pdf: 'application/pdf',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      bmp: 'image/bmp',
      ico: 'image/x-icon',
      svg: 'image/svg+xml',
      avif: 'image/avif',
      mp4: 'video/mp4',
      m4v: 'video/x-m4v',
      mov: 'video/quicktime',
      webm: 'video/webm',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      doc: 'application/msword',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      xls: 'application/vnd.ms-excel',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ppt: 'application/vnd.ms-powerpoint',
      hwp: 'application/x-hwp',
      hwpx: 'application/vnd.hancom.hwpx',
      db: 'application/vnd.sqlite3',
      sqlite: 'application/vnd.sqlite3',
      sqlite3: 'application/vnd.sqlite3',
    };

    // Download mode: stream file as attachment regardless of type. Do not buffer
    // large videos in Node or the browser before the native save dialog starts.
    if (isDownload) {
      const stat = fs.statSync(filePath);
      appendFileTransferEventSafe({
        actorUserId: userId,
        direction: 'download',
        transferKind: 'single',
        paths: [filePath],
        itemCount: 1,
        totalBytes: stat.isFile() ? stat.size : null,
      });
      const mimeType = (ext && binaryTypes[ext]) || 'application/octet-stream';
      streamFileResponse(req, res, filePath, {
        contentType: mimeType,
        disposition: 'attachment',
        fileName,
        allowRange: false,
      });
      return;
    }

    if (ext && binaryTypes[ext]) {
      // Browser/native media viewers need byte-range support for large videos and seeking.
      streamFileResponse(req, res, filePath, {
        contentType: binaryTypes[ext],
        disposition: 'inline',
        fileName,
        allowRange: true,
      });
      return;
    }

    const result = readFile(filePath);
    if (ext === 'html' || ext === 'htm') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(result.content);
    } else {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send(result.content);
    }
  } catch (error: any) {
    res.status(403).json({ error: error.message });
  }
});

// ───── Prompts ─────
router.get('/prompts', async (req, res) => {
  const userId = (req as any).user?.userId;
  const username = (req as any).user?.username || null;
  const projectId = req.query.projectId as string | undefined;
  const explicitCwd = typeof req.query.cwd === 'string' ? req.query.cwd : undefined;
  res.json(await getPromptsWithCommands(userId, username, projectId || null, explicitCwd));
});

router.post('/prompts', async (req, res) => {
  const { title, content } = req.body;
  if (!title || content === undefined) return res.status(400).json({ error: 'title and content required' });
  const userId = (req as any).user?.userId;
  const pin = await createPromptPin(title, content, userId);
  res.json(pin);
});

router.patch('/prompts/:id', async (req, res) => {
  const { title, content } = req.body;
  const userId = (req as any).user?.userId;
  await updatePromptPin(parseInt(req.params.id as string), { title, content }, userId);
  res.json({ ok: true });
});

router.delete('/prompts/:id', async (req, res) => {
  const userId = (req as any).user?.userId;
  await deletePin(parseInt(req.params.id as string), userId);
  res.json({ ok: true });
});

// ───── Git ─────
router.get('/git/log', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const author = req.query.author as string | undefined;
    const commits = await getLog(config.workspaceRoot, { limit, offset, author });
    res.json(commits);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/git/diff/:hash', async (req, res) => {
  try {
    const diff = await getFileDiff(config.workspaceRoot, req.params.hash as string);
    res.json({ diff });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/git/commit', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });
    const username = (req as any).user?.username || 'anonymous';
    const commit = await manualCommit(config.workspaceRoot, username, message);
    res.json(commit);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/git/rollback', async (req, res) => {
  try {
    const { hash } = req.body;
    if (!hash) return res.status(400).json({ error: 'hash required' });
    const username = (req as any).user?.username || 'anonymous';
    const commit = await rollbackToCommit(config.workspaceRoot, hash, username);
    res.json(commit);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ───── Config ─────
router.get('/config', (_req, res) => {
  const v = getVersionInfo();
  res.json({
    version: v.version,
    baseVersion: v.baseVersion,
    commitsSinceTag: v.commitsSinceTag,
    gitSha: v.gitSha,
    buildTime: v.buildTime,
    sourceRev: v.sourceRev,
    flakeLockNarHash: v.flakeLockNarHash,
    releaseMetadataSource: v.metadataSource,
    buildId: config.serverEpoch,
    publicUrl: config.publicUrl || null,
    towerRole: process.env.TOWER_ROLE || null,
    nodeEnv: process.env.NODE_ENV || null,
    workspaceRoot: config.workspaceRoot,
    permissionMode: config.permissionMode,
    claudeExecutable: config.claudeExecutable,
    models: config.claudeEnabled ? availableModels : [],
    connectionType: 'MAX',
    claudeEnabled: config.claudeEnabled,
    piEnabled: config.piEnabled,
    piModels: config.piEnabled ? config.piModels : [],
    localEnabled: config.localEnabled,
    localModels: config.localEnabled ? config.localModels : [],
    defaults: getModelDefaults(),
    inferenceReadiness: getInferenceProviderReadiness(),
    agentFirstEnabled: config.agentFirstEnabled,
    aiServicesEnabled: config.aiServicesEnabled,
    workspaceAppsEnabled: config.workspaceAppsEnabled,
    workspaceAppsMode: config.workspaceAppsMode,
    harnessAdministrationEnabled: config.towerRole === 'full',
    inlineEditEnabled: config.inlineEditEnabled,
    turnRewindEnabled: config.turnRewindEnabled,
    previewDirectEditEnabled: config.previewDirectEditEnabled,
    betaWorkbenchEnabled: isSkillWorkbenchEnabled(),
    // Dev-first CAD Workbench beta. This only exposes UI affordances; actual
    // project use still depends on the Runtime Box image/tooling being present.
    cadWorkbenchBetaEnabled: config.towerRole === 'full' || process.env.CAD_WORKBENCH_BETA === 'true',
  });
});


interface AgentAcademyDraftTemplate {
  id: string;
  face: string;
  name: string;
  levelTitle: string;
  role: string;
  capabilities: string[];
  sourceHints: string[];
  firstTask: string;
  promotionGoal: string;
}

const AGENT_ACADEMY_DRAFT_TEMPLATES: AgentAcademyDraftTemplate[] = [
  {
    id: 'company-profile', face: '📄', name: '회사소개서 성장 Agent', levelTitle: 'Level 0 · Trainee Writer',
    role: '회사소개서·제안서·영업 메시지를 계속 개선하고 좋은 문장과 근거를 축적합니다.',
    capabilities: ['자료에서 핵심 메시지와 proof를 뽑습니다.', '고객별 첫 장 메시지와 제안서 목차를 만듭니다.', '좋은 표현을 messaging bank 후보로 정리합니다.'],
    sourceHints: ['회사소개서', '제안서', '브로슈어', 'messaging bank'],
    firstTask: '현재 자료에서 고객에게 가장 먼저 보여줄 메시지 3개를 제안해줘.',
    promotionGoal: '승인된 메시지 3개를 재사용 가능한 후보로 정리하면 Level 1로 승급',
  },
  {
    id: 'cs', face: '🎧', name: '고객 문의 성장 Agent', levelTitle: 'Level 0 · Trainee Support',
    role: 'FAQ·정책·상담 사례를 바탕으로 고객 답변 초안과 내부 확인 항목을 분리합니다.',
    capabilities: ['고객 답변 초안을 만듭니다.', '사람 확인이 필요한 항목을 표시합니다.', '반복 문의를 FAQ 개선 후보로 축적합니다.'],
    sourceHints: ['FAQ', '정책 문서', '상담 기록'],
    firstTask: '최근 문의를 유형별로 나누고 답변 초안과 내부 확인 항목을 분리해줘.',
    promotionGoal: '답변 초안 3건을 내부 검토 가능한 형태로 만들면 Level 1로 승급',
  },
  {
    id: 'rfp', face: '📑', name: 'RFP/입찰 성장 Agent', levelTitle: 'Level 0 · Trainee Analyst',
    role: 'RFP/입찰 문서에서 제출 요건, 누락 자료, 제안서 구조, 리스크를 정리합니다.',
    capabilities: ['제출 요건과 마감을 분리합니다.', '누락 자료와 확인 질문을 정리합니다.', '제안서 목차와 리스크 표를 만듭니다.'],
    sourceHints: ['RFP', '입찰 문서', '제출 요건표'],
    firstTask: '이 RFP에서 제출 요건, 누락 자료, 제안서 목차, 주요 리스크를 정리해줘.',
    promotionGoal: '제출 요건/누락 자료/리스크 표를 1회 완성하면 Level 1로 승급',
  },
  {
    id: 'dev', face: '🧑‍💻', name: '개발 동료 성장 Agent', levelTitle: 'Level 0 · Trainee Builder',
    role: '제품 코드와 결정 기록을 읽고 작은 UI/기능 실험, 버그 수정, 검증 로그를 연결합니다.',
    capabilities: ['관련 코드와 결정문서를 찾습니다.', '작은 변경안을 제안하고 구현합니다.', 'typecheck/build/test 결과를 남깁니다.'],
    sourceHints: ['코드베이스', 'AGENTS.md', 'decisions'],
    firstTask: '이 제품 실험을 작은 구현 단위로 나누고 첫 변경안을 제안해줘.',
    promotionGoal: '첫 코드 변경에서 typecheck/build 검증까지 성공하면 Level 1로 승급',
  },
  {
    id: 'ops', face: '🗂️', name: '운영 PM 성장 Agent', levelTitle: 'Level 0 · Trainee Operator',
    role: '프로젝트 진행상황, 결정, 리스크, 다음 액션을 정리하고 반복 운영 루틴을 개선합니다.',
    capabilities: ['현재 상태와 다음 액션을 정리합니다.', '결정과 단순 메모를 구분합니다.', '반복 업무를 자동화/스킬 후보로 제안합니다.'],
    sourceHints: ['회의록', 'progress', 'decisions', '업무 기록'],
    firstTask: '현재 진행상황, 막힌 점, 다음 3개 액션을 정리해줘.',
    promotionGoal: '진행상황/막힌 점/다음 액션을 정기 요약하면 Level 1로 승급',
  },
  {
    id: 'custom', face: '✨', name: '직접 키울 Agent', levelTitle: 'Level 0 · Trainee',
    role: '사용자가 지정한 반복 업무를 배우고 수행하면서 점점 더 나은 작업 기준을 축적합니다.',
    capabilities: ['역할을 대화로 구체화합니다.', '첫 업무를 제안합니다.', '반복 절차를 스킬/자동화 후보로 정리합니다.'],
    sourceHints: ['대화로 먼저 시작'],
    firstTask: '이 Agent가 맡을 지속 역할과 첫 업무를 함께 정해줘.',
    promotionGoal: '첫 업무를 성공적으로 마치면 Level 1로 승급',
  },
];

function pickAgentAcademyDraftTemplate(intent: string, material: string): AgentAcademyDraftTemplate {
  const text = `${intent || ''}\n${material || ''}`;
  if (/(rfp|입찰|제안요청|공고|tender|요건|제출)/i.test(text)) return AGENT_ACADEMY_DRAFT_TEMPLATES.find(t => t.id === 'rfp')!;
  if (/(faq|cs|상담|문의|고객센터|환불|정책|답변)/i.test(text)) return AGENT_ACADEMY_DRAFT_TEMPLATES.find(t => t.id === 'cs')!;
  if (/(tower|frontend|backend|typescript|react|vite|api|bug|버그|코드|개발)/i.test(text)) return AGENT_ACADEMY_DRAFT_TEMPLATES.find(t => t.id === 'dev')!;
  if (/(progress|pm|운영|프로젝트|회의록|결정|todo|액션|일정)/i.test(text)) return AGENT_ACADEMY_DRAFT_TEMPLATES.find(t => t.id === 'ops')!;
  if (/(회사소개|소개서|브로슈어|proposal|제안서|영업|sales|고객사|브랜드|메시지)/i.test(text)) return AGENT_ACADEMY_DRAFT_TEMPLATES.find(t => t.id === 'company-profile')!;
  return AGENT_ACADEMY_DRAFT_TEMPLATES.find(t => t.id === 'custom')!;
}

function splitMaterialCandidates(material: string): string[] {
  return String(material || '')
    .split(/\n|,/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8);
}

router.post('/agents/academy/draft', async (req, res) => {
  try {
    if (!config.agentFirstEnabled) return res.status(404).json({ error: 'Agent-first feature is not enabled' });
    const intent = typeof req.body?.intent === 'string' ? req.body.intent : '';
    const material = typeof req.body?.material === 'string' ? req.body.material : '';
    const template = pickAgentAcademyDraftTemplate(intent, material);
    const materials = splitMaterialCandidates(material);
    const role = intent.trim()
      ? `${template.role} 사용자가 설명한 육성 방향: ${intent.trim()}`
      : template.role;
    res.json({
      status: 'draft',
      templateId: template.id,
      face: template.face,
      name: template.name,
      levelTitle: template.levelTitle,
      role,
      capabilities: template.capabilities,
      sourceHints: materials.length ? materials : template.sourceHints,
      firstTask: template.firstTask,
      promotionGoal: template.promotionGoal,
      assumptions: [
        materials.length ? '자료명/사용자 설명 기반 초안입니다. 실제 파일 내용 분석은 후속 단계입니다.' : '자료가 없어도 대화로 먼저 설정할 수 있습니다.',
        '이 draft는 확정 전 사용자가 수정할 수 있습니다.',
      ],
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ───── Project Agent Definitions ─────
router.get('/agents', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    const projectId = req.query.projectId as string | undefined;
    const explicitCwd = typeof req.query.cwd === 'string' ? req.query.cwd : undefined;
    let projectRoot = explicitCwd || null;
    if (projectId) {
      const project = await queryOne<{ root_path: string }>('SELECT root_path FROM projects WHERE id = $1', [projectId]);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      if (userId && !(await isPathAccessible(project.root_path, userId, role))) {
        return res.status(403).json({ error: 'Project not accessible' });
      }
      projectRoot = project.root_path;
    }
    const definitions = loadProjectAgentDefinitions(projectRoot);
    if (!userId) return res.json(definitions);

    const enriched = [];
    for (const definition of definitions) {
      const worker = await queryOne<any>(
        `SELECT id, name, status, visibility, backing_session_id, metadata, updated_at, last_heartbeat_at
           FROM agent_workers
          WHERE owner_user_id = $1
            AND ($2::text IS NULL OR project_id = $2)
            AND metadata->>'definitionId' = $3
          ORDER BY updated_at DESC
          LIMIT 1`,
        [userId, projectId || null, definition.id],
      );
      const latestRun = worker ? await queryOne<any>(
        `SELECT id, status, result_summary, artifact_paths, error, started_at, ended_at, updated_at, metadata
           FROM agent_runs
          WHERE worker_id = $1
          ORDER BY created_at DESC
          LIMIT 1`,
        [worker.id],
      ) : null;
      const stateCard = worker ? await queryOne<any>(
        `SELECT goal, current_focus, last_action, next_action, blockers, open_questions, important_artifacts, confidence, updated_at
           FROM agent_state_cards
          WHERE worker_id = $1`,
        [worker.id],
      ) : null;
      enriched.push({ ...definition, worker, latestRun, stateCard });
    }
    return res.json(enriched);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/agents', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    const projectId = req.body?.projectId as string | undefined;
    if (!projectId) return res.status(400).json({ error: 'projectId is required' });
    const project = await queryOne<{ root_path: string }>('SELECT root_path FROM projects WHERE id = $1', [projectId]);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (userId && !(await isPathWritableByRole(project.root_path, userId, role || 'member'))) {
      return res.status(403).json({ error: 'Project not writable' });
    }
    const saved = saveProjectAgentDefinition(project.root_path, req.body?.definition, { overwrite: false });
    res.status(201).json(saved);
  } catch (err: any) {
    const status = err?.code === 'AGENT_EXISTS' ? 409 : /unsupported modelPolicy|unsupported effort/.test(err?.message || '') ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

router.put('/agents/:id', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    const projectId = req.body?.projectId as string | undefined;
    if (!projectId) return res.status(400).json({ error: 'projectId is required' });
    const project = await queryOne<{ root_path: string }>('SELECT root_path FROM projects WHERE id = $1', [projectId]);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (userId && !(await isPathWritableByRole(project.root_path, userId, role || 'member'))) {
      return res.status(403).json({ error: 'Project not writable' });
    }
    const saved = saveProjectAgentDefinition(project.root_path, req.body?.definition, { overwrite: true, existingId: req.params.id });
    res.json(saved);
  } catch (err: any) {
    const status = /unsupported modelPolicy|unsupported effort/.test(err?.message || '') ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ───── Commands (now registry-backed metadata only) ─────
router.get('/commands', async (req, res) => {
  const userId = (req as any).user?.userId;
  const username = (req as any).user?.username || null;
  const projectId = req.query.projectId as string | undefined;
  const explicitCwd = typeof req.query.cwd === 'string' ? req.query.cwd : undefined;

  // The Tower registry is authoritative for slash commands. Do not fall back to
  // a host-global filesystem scan here: SDK/legacy command sources can include
  // admin-only or unrelated project commands and leak them into member sessions.
  // If the registry returns no commands, the correct user-facing result is an
  // empty list.
  try {
    const commands = await getCommandsForUser(userId, projectId || null, username, explicitCwd);
    return res.json(commands.map(({ fullContent: _fullContent, ...cmd }) => cmd));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ───── Skills Registry ─────
router.get('/skills', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    const username = (req as any).user?.username || null;
    const scope = req.query.scope as 'company' | 'project' | 'personal' | undefined;
    const projectId = req.query.projectId as string | undefined;
    if (projectId && userId) {
      const project = await queryOne<{ root_path: string }>('SELECT root_path FROM projects WHERE id = $1', [projectId]);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      if (!(await isPathAccessible(project.root_path, userId, role))) {
        return res.status(403).json({ error: 'Project not accessible' });
      }
    }
    const skills = await listSkills(scope, projectId, userId, username);
    res.json(await attachSkillUsageStats(skills));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/skills/:id/doctor', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const projectId = (req.query.projectId as string | undefined) || null;
    res.json(await getSkillRegistryDoctor(req.params.id, userId, projectId));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/skills/:id', async (req, res) => {
  try {
    const skill = await getSkill(req.params.id);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    const root = resolveSkillBundleRoot(skill);
    const files: string[] = root ? listSkillBundleFiles(root) : [];
    res.json({ ...skill, files });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/skills/:id/file', async (req, res) => {
  try {
    const skill = await getSkill(req.params.id);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    const root = resolveSkillBundleRoot(skill);
    if (!root) return res.status(404).json({ error: 'Skill files not found' });

    const rel = typeof req.query.path === 'string' ? req.query.path : 'SKILL.md';
    if (!rel || rel.includes('..') || path.isAbsolute(rel)) return res.status(400).json({ error: 'Invalid file path' });
    const full = path.resolve(root, rel);
    if (!full.startsWith(path.resolve(root) + path.sep) && full !== path.resolve(root)) return res.status(400).json({ error: 'Invalid file path' });
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return res.status(404).json({ error: 'File not found' });

    const stat = fs.statSync(full);
    const maxBytes = 512 * 1024;
    const buffer = fs.readFileSync(full);
    const binary = buffer.subarray(0, Math.min(buffer.length, 1024)).includes(0);
    res.json({
      path: rel,
      content: binary ? '' : buffer.subarray(0, maxBytes).toString('utf-8'),
      binary,
      truncated: buffer.length > maxBytes,
      size: stat.size,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

function resolveSkillBundleRoot(skill: { skillPath?: string | null; name: string }): string | null {
  const candidates = [
    skill.skillPath ? (fs.existsSync(skill.skillPath) && fs.statSync(skill.skillPath).isDirectory() ? skill.skillPath : path.dirname(skill.skillPath)) : null,
    path.join(os.homedir(), '.claude', 'skills', skill.name),
    path.join(config.dataDir, 'skills', 'company', skill.name),
  ].filter(Boolean) as string[];
  return candidates.find(dir => fs.existsSync(dir) && fs.statSync(dir).isDirectory()) ?? null;
}

async function attachSkillUsageStats<T extends Array<{ name: string }>>(skills: T): Promise<T> {
  if (skills.length === 0) return skills;
  const names = Array.from(new Set(skills.map(s => s.name)));
  try {
    const rows = await query<{ skill_name: string; recent_count: string; total_count: string; last_used_at: string | null }>(
      `SELECT raw_payload->>'skillName' AS skill_name,
              COUNT(*) FILTER (WHERE occurred_at >= NOW() - INTERVAL '30 days')::text AS recent_count,
              COUNT(*)::text AS total_count,
              MAX(occurred_at)::text AS last_used_at
         FROM process_events
        WHERE source_type = 'skill_invocation'
          AND event_type = 'step_started'
          AND raw_payload->>'skillName' = ANY($1)
        GROUP BY raw_payload->>'skillName'`,
      [names],
    );
    const byName = new Map(rows.map(r => [r.skill_name, r]));
    for (const skill of skills as any[]) {
      const row = byName.get(skill.name);
      skill.recentUsageCount = row ? Number(row.recent_count) || 0 : 0;
      skill.usageCount = row ? Number(row.total_count) || 0 : 0;
      skill.lastUsedAt = row?.last_used_at ?? null;
    }
  } catch {
    for (const skill of skills as any[]) {
      skill.recentUsageCount = 0;
      skill.usageCount = 0;
      skill.lastUsedAt = null;
    }
  }
  return skills;
}

function listSkillBundleFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (d: string, prefix: string) => {
    try {
      for (const item of fs.readdirSync(d, { withFileTypes: true })) {
        if (item.name.startsWith('.')) continue;
        const rel = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.isDirectory()) {
          files.push(`${rel}/`);
          walk(path.join(d, item.name), rel);
        } else {
          files.push(rel);
        }
      }
    } catch {}
  };
  walk(root, '');
  return files.sort((a, b) => (a === 'SKILL.md' ? -1 : b === 'SKILL.md' ? 1 : a.localeCompare(b)));
}

router.post('/skills/:id/copy', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const skill = await copySkillToPersonal(req.params.id, userId);
    res.json(skill);
  } catch (err: any) {
    const msg = err.message || String(err);
    const status = msg.includes('not found') ? 404 : msg.includes('Only public/default') ? 403 : 400;
    res.status(status).json({ error: msg });
  }
});

router.post('/skills/:id/share-company', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const skill = await getSkill(req.params.id);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    if (skill.scope !== 'project' || !skill.skillPath) {
      return res.status(400).json({ error: 'Only project skills can be shared to the company catalog' });
    }
    if (!(await isPathAccessible(skill.skillPath, userId, role))) {
      return res.status(403).json({ error: 'Project skill not accessible' });
    }
    const projectRoot = resolveSessionProjectRoot(skill.skillPath);
    const project = projectRoot ? await queryOne<{ id: string }>('SELECT id FROM projects WHERE root_path = $1', [projectRoot]) : null;
    if (project) {
      const access = await canCreateInProject(project.id, userId, role);
      if (!access.allowed) return res.status(access.status).json({ error: access.message });
    }

    res.json(await shareProjectSkillToCompany(req.params.id));
  } catch (err: any) {
    const msg = err.message || String(err);
    const status = msg.includes('different content') ? 409 : msg.includes('not found') ? 404 : 400;
    res.status(status).json({ error: msg });
  }
});

router.post('/skills', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    const { name, scope, content, description, category, projectId, visibility } = req.body;

    if (!name || !scope || !content) {
      return res.status(400).json({ error: 'name, scope, content required' });
    }

    if (!['personal', 'project', 'company'].includes(scope)) {
      return res.status(400).json({ error: 'Invalid skill scope' });
    }

    // Company/org skills are DB read-only. Share project skills into teamskills
    // with share-skill; runtime copies are produced by materialization.
    if (scope === 'company') {
      return res.status(400).json({
        error: 'Company scope is read-only',
        hint: 'Use share-skill to copy/update organization skills under workspace/projects/teamskills/skills/<name>, then materialize selected projects.',
      });
    }
    if (scope === 'personal') {
      return res.status(400).json({ error: 'Personal skills are deprecated. Create a project skill instead.' });
    }
    if (scope === 'project' && !projectId) {
      return res.status(400).json({ error: 'projectId required for project skill' });
    }
    if (scope === 'project' && projectId && userId) {
      const access = await canCreateInProject(projectId, userId, role);
      if (!access.allowed) return res.status(access.status).json({ error: access.message });
    }
    void role;

    const skill = await createSkill({
      name, scope, content, description, category,
      projectId: scope === 'project' ? projectId : undefined,
      userId: scope === 'personal' ? userId : undefined,
      visibility,
    });
    res.json(skill);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/skills/:id', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;

    const existing = await getSkill(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Skill not found' });

    // Company/org skills are DB read-only. Share project skills into teamskills
    // with share-skill; runtime copies are produced by materialization.
    if (existing.scope === 'company') {
      return res.status(400).json({
        error: 'Company scope is read-only',
        hint: 'Use share-skill to copy/update organization skills under workspace/projects/teamskills/skills/<name>, then materialize selected projects.',
      });
    }
    if (existing.scope === 'personal') {
      return res.status(400).json({ error: 'Personal skills are deprecated and read-only' });
    }
    if (existing.scope === 'project' && existing.skillPath) {
      const projectRoot = resolveSessionProjectRoot(existing.skillPath);
      const project = projectRoot ? await queryOne<{ id: string }>('SELECT id FROM projects WHERE root_path = $1', [projectRoot]) : null;
      if (!project && !isPrivilegedRole(role)) {
        return res.status(403).json({ error: 'Project skill is not attached to an accessible project' });
      }
      if (project && userId) {
        const access = await canCreateInProject(project.id, userId, role);
        if (!access.allowed) return res.status(access.status).json({ error: access.message });
      }
    }

    const ok = await updateSkill(req.params.id, req.body);
    res.json({ ok });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/skills/:id', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;

    const existing = await getSkill(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Skill not found' });

    // 2026-04-17: company 스킬은 read-only — library.yaml 에서 제거해야 함.
    if (existing.scope === 'company') {
      return res.status(400).json({
        error: 'Company scope is read-only',
        hint: 'Remove from library.yaml and redeploy.',
      });
    }
    if (existing.scope === 'personal') {
      return res.status(400).json({ error: 'Personal skills are deprecated and read-only' });
    }
    if (existing.scope === 'project' && existing.skillPath) {
      const projectRoot = resolveSessionProjectRoot(existing.skillPath);
      const project = projectRoot ? await queryOne<{ id: string }>('SELECT id FROM projects WHERE root_path = $1', [projectRoot]) : null;
      if (!project && !isPrivilegedRole(role)) {
        return res.status(403).json({ error: 'Project skill is not attached to an accessible project' });
      }
      if (project && userId) {
        const access = await canCreateInProject(project.id, userId, role);
        if (!access.allowed) return res.status(access.status).json({ error: access.message });
      }
    }

    const ok = await deleteSkill(req.params.id);
    res.json({ ok });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Per-user skill toggle (enable/disable a skill for yourself)
// 2026-04-17: user_skill_prefs는 skill_name 기반. :id가 UUID면 getSkill로 name 복원.
router.post('/skills/:id/toggle', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const skill = await getSkill(req.params.id);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    const { enabled } = req.body;
    const newState = enabled !== undefined ? !!enabled : !((await getUserSkillPref(userId, skill.name)) ?? true);
    await setUserSkillPref(userId, skill.name, newState);
    res.json({ ok: true, enabled: newState });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ───── Spaces ─────
router.get('/spaces', async (_req, res) => {
  try { res.json(await listSpaces()); } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/spaces', adminMiddleware, async (req, res) => {
  try {
    const { name, slug, description, type, color, icon } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name required' });
    const space = await createSpace(name.trim(), { slug, description, type, color, icon });
    res.json(space);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.patch('/spaces/:id', adminMiddleware, async (req, res) => {
  try {
    const space = await updateSpace(parseInt(req.params.id as string), req.body);
    if (!space) return res.status(404).json({ error: 'space not found' });
    res.json(space);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete('/spaces/:id', adminMiddleware, async (req, res) => {
  try {
    await deleteSpace(parseInt(req.params.id as string));
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ───── Projects ─────
//
// Realtime broadcasting (added 2026-04-10): every mutating project endpoint
// now fans out a WS event to the project's members so other tabs/devices
// update their sidebars without a refresh. See decisions/2026-04-10-realtime-sync-and-scale.md

/** Fire a WS event to every distinct member of a project, plus an optional extra user. */
async function broadcastToProjectMembers(
  projectId: string,
  data: any,
  extraUserId?: number,
): Promise<void> {
  try {
    const members = await getProjectMembers(projectId);
    const seen = new Set<number>();
    for (const m of members) {
      if (seen.has(m.userId)) continue;
      seen.add(m.userId);
      broadcastToUser(m.userId, data);
    }
    if (extraUserId !== undefined && !seen.has(extraUserId)) {
      broadcastToUser(extraUserId, data);
    }
  } catch (err: any) {
    console.error('[broadcastToProjectMembers] failed:', err?.message || err);
  }
}

router.get('/projects/:id/activity-graph', async (req, res) => {
  try {
    const userId = (req as any).user?.userId as number | undefined;
    const role = String((req as any).user?.role || 'member');
    if (!userId) return res.status(401).json({ error: 'auth required' });
    const projectId = req.params.id;
    const project = (await getProjects(userId, role)).find((item: any) => item.id === projectId);
    if (!project) return res.status(404).json({ error: 'project not found' });
    const rangeDays = parseInt(String(req.query.rangeDays || '90'), 10) || 90;
    const sessionLimit = parseInt(String(req.query.sessionLimit || '50'), 10) || 50;
    res.json(await getProjectActivityGraph(projectId, userId, { rangeDays, sessionLimit }));
  } catch (err: any) {
    console.error('[api] project activity graph failed:', err);
    res.status(500).json({ error: err?.message || 'failed to load project activity graph' });
  }
});

router.get('/projects/:id/agent-home', async (req, res) => {
  try {
    const userId = (req as any).user?.userId as number | undefined;
    const role = String((req as any).user?.role || 'member');
    if (!userId) return res.status(401).json({ error: 'auth required' });
    const projectId = req.params.id;
    const project = (await getProjects(userId, role)).find((item: any) => item.id === projectId);
    if (!project) return res.status(404).json({ error: 'project not found' });
    const [ledger, invocations, sessions, activity, memberCount, userStats, activity30, skillUsage, createdSkillList, collaboration, relationship] = await Promise.all([
      query<any>(`SELECT DISTINCT ON (workstream_key) workstream_key, workstream_title, run_title, status, updated_at FROM work_ledger_records WHERE project_id=$1 ORDER BY workstream_key, updated_at DESC`, [projectId]),
      queryOne<any>(`SELECT COUNT(*)::int count FROM process_events WHERE project_id=$1 AND source_type='skill_invocation' AND event_type='step_completed'`, [projectId]),
      query<any>(`SELECT s.id,s.name,s.summary,s.updated_at,s.created_at,s.user_id,COALESCE(u.display_name,u.username,'알 수 없음') user_name FROM sessions s LEFT JOIN users u ON u.id=s.user_id WHERE s.project_id=$1 AND COALESCE(s.archived,0)=0 AND (s.user_id=$2 OR s.visibility='project') ORDER BY s.updated_at DESC LIMIT 3`, [projectId,userId]),
      query<any>(`SELECT DATE_TRUNC('day',m.created_at)::date AS usage_day,COUNT(*)::int AS turns FROM messages m JOIN sessions s ON s.id=m.session_id WHERE s.project_id=$1 AND m.role='user' AND m.created_at>=CURRENT_DATE-INTERVAL '13 days' GROUP BY DATE_TRUNC('day',m.created_at)::date ORDER BY usage_day`, [projectId]),
      queryOne<any>(`SELECT COUNT(DISTINCT user_id)::int count FROM project_members WHERE project_id=$1`, [projectId]),
      query<any>(`SELECT s.user_id,COALESCE(u.display_name,u.username,'알 수 없음') user_name,COUNT(DISTINCT s.id)::int session_count,COUNT(m.id)::int turn_count FROM sessions s LEFT JOIN users u ON u.id=s.user_id LEFT JOIN messages m ON m.session_id=s.id AND m.role='user' WHERE s.project_id=$1 GROUP BY s.user_id,u.display_name,u.username ORDER BY turn_count DESC`, [projectId]),
      query<any>(`SELECT DATE_TRUNC('day',m.created_at)::date AS usage_day,COUNT(*) FILTER(WHERE m.role='user')::int turns,COALESCE(SUM(m.input_tokens),0)::bigint input_tokens,COALESCE(SUM(m.output_tokens),0)::bigint output_tokens FROM messages m JOIN sessions s ON s.id=m.session_id WHERE s.project_id=$1 AND m.created_at>=CURRENT_DATE-INTERVAL '29 days' GROUP BY DATE_TRUNC('day',m.created_at)::date ORDER BY usage_day`, [projectId]),
      query<any>(`SELECT COALESCE(raw_payload->>'skillName','unknown') skill_name,COUNT(*)::int usage_count FROM process_events WHERE project_id=$1 AND source_type='skill_invocation' AND event_type='step_completed' GROUP BY 1 ORDER BY usage_count DESC LIMIT 8`, [projectId]),
      query<any>(`SELECT skill_name,attributed_at AS created_at FROM project_agent_skill_attributions WHERE project_id=$1 AND status='active' ORDER BY attributed_at DESC LIMIT 8`, [projectId]),
      queryOne<any>(`SELECT COUNT(DISTINCT workstream_key)::int total_workstreams,COUNT(DISTINCT workstream_key) FILTER(WHERE owner_user_id=$2)::int my_workstreams FROM work_ledger_records WHERE project_id=$1`, [projectId,userId]),
      queryOne<any>(`SELECT p.created_at joined_at,pm.added_at collaboration_started_at FROM projects p LEFT JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=$2 WHERE p.id=$1`, [projectId,userId]),
    ]);
    const completedWorkstreams = ledger.filter((item:any)=>item.status==='completed').length;
    const careerMetrics: AgentCareerMetrics = { completedWorkstreams, successfulSkillInvocations: Number(invocations?.count) || 0 };
    const careerLevel = highestAgentCareerLevel((project.agent?.careerLevel || 'intern') as AgentCareerLevel, deriveAgentCareerLevel(careerMetrics));
    const agent = project.agent ? { ...project.agent, careerLevel } : project.agent;
    const activeWork = ledger.filter((item:any)=>item.status!=='completed'&&!['cancelled','failed'].includes(item.status)).slice(0,5);
    res.json({
      agent,
      activeWork,
      recentSessions: sessions.map((row:any)=>({ id:row.id,name:row.name,summary:row.summary,updatedAt:row.updated_at,createdAt:row.created_at,userName:row.user_name })),
      career: { level: careerLevel, metrics: careerMetrics },
      activity: { totalTurns: activity.reduce((sum:any,item:any)=>sum+Number(item.turns||0),0), dailyTurns: activity.map((row:any)=>({day:row.usage_day,turns:Number(row.turns)||0})), memberCount: memberCount?.count || 1, userStats, daily30: (()=>{const map=new Map(activity30.map((row:any)=>[new Date(row.usage_day).toISOString().slice(0,10),{turns:Number(row.turns)||0,tokens:Number(row.input_tokens||0)+Number(row.output_tokens||0)}]));const today=new Date();today.setUTCHours(0,0,0,0);return Array.from({length:30},(_,index)=>{const day=new Date(today);day.setUTCDate(day.getUTCDate()-29+index);const key=day.toISOString().slice(0,10);return{day:key,...(map.get(key)||{turns:0,tokens:0})};});})() },
      skills: { mostUsed: skillUsage, created: createdSkillList },
      collaboration: { totalWorkstreams: collaboration?.total_workstreams || 0, myWorkstreams: collaboration?.my_workstreams || 0, joinedAt: relationship?.joined_at || null, collaborationStartedAt: relationship?.collaboration_started_at || null },
    });
  } catch (err:any) { res.status(500).json({ error: err?.message || 'failed to load agent home' }); }
});

router.get('/projects', async (req, res) => {
  const userId = (req as any).user?.userId;
  const role = (req as any).user?.role;
  const projects = await getProjects(userId, role);
  const ids = projects.map((project:any)=>project.id);
  const [counts,usage,careerRows,membershipRows,recentWorkRows] = ids.length ? await Promise.all([
    query<any>(`SELECT project_id,COUNT(DISTINCT user_id)::int member_count FROM project_members WHERE project_id=ANY($1::text[]) GROUP BY project_id`, [ids]),
    query<any>(`SELECT s.project_id,DATE_TRUNC('day',m.created_at)::date AS usage_day,COUNT(*)::int AS turns FROM messages m JOIN sessions s ON s.id=m.session_id WHERE s.project_id=ANY($1::text[]) AND m.role='user' AND m.created_at>=CURRENT_DATE-INTERVAL '13 days' GROUP BY s.project_id,DATE_TRUNC('day',m.created_at)::date ORDER BY s.project_id,usage_day`, [ids]),
    query<any>(`SELECT p.id project_id,(SELECT COUNT(DISTINCT workstream_key) FROM work_ledger_records w WHERE w.project_id=p.id AND w.status='completed')::int completed_workstreams,(SELECT COUNT(*) FROM process_events e WHERE e.project_id=p.id AND e.source_type='skill_invocation' AND e.event_type='step_completed')::int successful_skill_invocations FROM projects p WHERE p.id=ANY($1::text[])`, [ids]),
    query<any>(`SELECT p.id project_id,p.user_id creator_user_id,pm.role membership_role,pm.added_at FROM projects p LEFT JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=$2 WHERE p.id=ANY($1::text[])`, [ids,userId]),
    query<any>(`SELECT project_id,MAX(updated_at) last_worked_at FROM sessions WHERE project_id=ANY($1::text[]) AND user_id=$2 AND COALESCE(archived,0)=0 GROUP BY project_id`, [ids,userId]),
  ]) : [[],[],[],[],[]];
  const byProject = new Map(counts.map((row:any)=>[row.project_id,Number(row.member_count)||0]));
  const usageByProject = new Map<string,Map<string,number>>();
  const membershipByProject = new Map(membershipRows.map((row:any)=>[row.project_id,{creatorUserId:Number(row.creator_user_id)||null,membershipRole:row.membership_role,invitedAt:row.added_at}]));
  const recentWorkByProject = new Map(recentWorkRows.map((row:any)=>[row.project_id,row.last_worked_at]));
  const careerByProject = new Map(careerRows.map((row:any)=>[row.project_id,{completedWorkstreams:Number(row.completed_workstreams)||0,successfulSkillInvocations:Number(row.successful_skill_invocations)||0}]));
  for(const row of usage){const map=usageByProject.get(row.project_id)||new Map<string,number>();map.set(new Date(row.usage_day).toISOString().slice(0,10),Number(row.turns)||0);usageByProject.set(row.project_id,map);}
  const today=new Date();today.setUTCHours(0,0,0,0);
  res.json(projects.map((project:any)=>{const map=usageByProject.get(project.id)||new Map<string,number>();const dailyTurns=Array.from({length:7},(_,index)=>{const day=new Date(today);day.setUTCDate(day.getUTCDate()-6+index);const key=day.toISOString().slice(0,10);return{day:key,turns:map.get(key)||0};});const previous7=Array.from({length:7},(_,index)=>{const day=new Date(today);day.setUTCDate(day.getUTCDate()-13+index);return map.get(day.toISOString().slice(0,10))||0;}).reduce((sum,value)=>sum+value,0);const recent7=dailyTurns.reduce((sum,item)=>sum+item.turns,0);const careerMetrics=(careerByProject.get(project.id)||{completedWorkstreams:0,successfulSkillInvocations:0}) as AgentCareerMetrics;const careerLevel=highestAgentCareerLevel((project.agent?.careerLevel||'intern') as AgentCareerLevel,deriveAgentCareerLevel(careerMetrics));const agent=project.agent?{...project.agent,careerLevel}:project.agent;return{...project,agent,...(membershipByProject.get(project.id)||{}),invitedByOther:(membershipByProject.get(project.id)?.creatorUserId||null)!==userId,lastWorkedAt:recentWorkByProject.get(project.id)||null,memberCount:Math.max(1,byProject.get(project.id)||0),careerMetrics,recentUsage:{recent7,previous7,changePercent:previous7?Math.round(((recent7-previous7)/previous7)*100):null,dailyTurns}};}));
});

router.get('/channel-agents', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (!userId) return res.status(401).json({ error: 'auth required' });
    const projects = await getProjects(userId, role);
    if (projects.length === 0) return res.json({ agents: [] });
    const ids = projects.map((project: any) => project.id);
    const profiles = await query<any>(
      `SELECT p.id AS project_id,
              COALESCE(NULLIF(pap.display_name, ''), p.name) AS display_name,
              COALESCE(NULLIF(pap.face, ''), '✨') AS face,
              pap.tagline,
              COALESCE(pap.status, 'active') AS status
         FROM projects p
         LEFT JOIN project_agent_profiles pap ON pap.project_id = p.id
        WHERE p.id = ANY($1::text[])
          AND COALESCE(pap.status, 'active') IN ('active', 'ready')
        ORDER BY COALESCE(NULLIF(pap.display_name, ''), p.name) ASC`,
      [ids],
    );
    res.json({ agents: profiles.map((row: any) => ({
      projectId: row.project_id,
      displayName: row.display_name,
      face: row.face,
      tagline: row.tagline || null,
    })) });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'failed to list channel agents' });
  }
});

router.put('/projects/pins', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (!userId) return res.status(401).json({ error: 'auth required' });
    const { projectIds } = req.body;
    if (!Array.isArray(projectIds)) return res.status(400).json({ error: 'projectIds array required' });
    await saveUserProjectPins(userId, role, projectIds);
    res.json(await getProjects(userId, role));
  } catch (err: any) {
    const message = err?.message || 'failed to save project pins';
    res.status(message.includes('inaccessible') ? 403 : 500).json({ error: message });
  }
});

router.post('/projects', async (req, res) => {
  try {
    const { name, slug, description, rootPath, color, memberIds, spaceId, agentProfile } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name required' });
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    // 2026-05-04: guest/viewer 는 프로젝트 생성 ❌ (decisions/2026-05-04-five-role-model.md)
    if (role === 'guest' || role === 'viewer') {
      return res.status(403).json({ error: `Role '${role}' cannot create projects` });
    }
    if (agentProfile && typeof agentProfile === 'object' && !config.agentFirstEnabled) {
      return res.status(404).json({ error: 'Agent-first feature is not enabled' });
    }
    const project = await createProject(name.trim(), userId, { description, rootPath, color, spaceId: spaceId ?? null, slug });

    if (agentProfile && typeof agentProfile === 'object') {
      await execute(
        `INSERT INTO project_agent_profiles
           (project_id, display_name, face, tagline, role, promise, instruction,
            instruction_source, default_engine, default_model, authority_policy,
            tool_policy, memory_policy, budget_policy, onboarding_state, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'employee-card', $8, $9, $10::jsonb,
                 $11::jsonb, $12::jsonb, $13::jsonb, 'ready', $14::jsonb)
         ON CONFLICT (project_id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           face = EXCLUDED.face,
           tagline = EXCLUDED.tagline,
           role = EXCLUDED.role,
           promise = EXCLUDED.promise,
           instruction = EXCLUDED.instruction,
           instruction_source = EXCLUDED.instruction_source,
           default_engine = EXCLUDED.default_engine,
           default_model = EXCLUDED.default_model,
           authority_policy = EXCLUDED.authority_policy,
           tool_policy = EXCLUDED.tool_policy,
           memory_policy = EXCLUDED.memory_policy,
           budget_policy = EXCLUDED.budget_policy,
           metadata = EXCLUDED.metadata,
           instruction_version = project_agent_profiles.instruction_version + 1,
           updated_at = NOW()`,
        [
          project.id,
          typeof agentProfile.displayName === 'string' ? agentProfile.displayName.trim() || null : null,
          typeof agentProfile.face === 'string' ? agentProfile.face.trim() || null : null,
          typeof agentProfile.tagline === 'string' ? agentProfile.tagline.trim() || null : null,
          typeof agentProfile.role === 'string' ? agentProfile.role.trim() || null : null,
          typeof agentProfile.promise === 'string' ? agentProfile.promise.trim() || null : null,
          typeof agentProfile.instruction === 'string' ? agentProfile.instruction.trim() || null : null,
          agentProfile.defaultEngine === 'pi' || agentProfile.defaultEngine === 'claude' ? agentProfile.defaultEngine : null,
          typeof agentProfile.defaultModel === 'string' ? agentProfile.defaultModel.trim() || null : null,
          JSON.stringify(agentProfile.authorityPolicy ?? {}),
          JSON.stringify(agentProfile.toolPolicy ?? {}),
          JSON.stringify(agentProfile.memoryPolicy ?? {}),
          JSON.stringify(agentProfile.budgetPolicy ?? {}),
          JSON.stringify(agentProfile.metadata ?? {}),
        ],
      );

      if (project.rootPath) ensureProjectAgentInstruction(project.rootPath, agentProfile);
    }

    const createdProject = await getProject(project.id) || project;

    // Add individual members
    if (Array.isArray(memberIds)) {
      for (const mid of memberIds) {
        if (typeof mid === 'number' && mid !== userId) {
          await addProjectMember(project.id, mid, 'member');
        }
      }
    }
    res.json(createdProject);

    // Realtime: push new project to every member (incl. creator cross-device)
    broadcastToProjectMembers(project.id, { type: 'project_created', project: createdProject }, userId);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/agent-characters/generated/:id', async (req, res) => {
  const imagePath = generatedCharacterPath(req.params.id);
  if (!imagePath || !fs.existsSync(imagePath)) return res.status(404).json({ error: 'character not found' });
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.type('png').sendFile(imagePath);
});

router.post('/agent-characters/generate', async (req, res) => {
  try {
    const userId = (req as any).user?.userId as number | undefined;
    const role = (req as any).user?.role;
    if (!userId) return res.status(401).json({ error: 'auth required' });
    if (role === 'guest' || role === 'viewer') return res.status(403).json({ error: 'this role cannot generate teammate characters' });
    const projectId = String(req.body?.projectId || '');
    if (!projectId || (!isPrivilegedRole(role) && !(await isProjectMember(projectId, userId)))) {
      return res.status(403).json({ error: '이 Project에서는 얼굴을 생성할 수 없습니다.' });
    }
    const generated = await generateAgentCharacter({ projectId, userId, prompt: String(req.body?.prompt || '') });
    res.status(201).json({ ...generated, url: `/api/agent-characters/generated/${generated.id}` });
  } catch (err: any) {
    const credentialUnavailable = err instanceof SecretAccessDeniedError
      || (err instanceof AgentCharacterGenerationError && err.kind === 'credential_unavailable');
    const message = credentialUnavailable
      ? '이미지 생성 연결을 사용할 수 없습니다. 관리자에게 OpenAI Image 연결 상태를 확인해 달라고 요청해 주세요.'
      : '얼굴을 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.';
    res.status(credentialUnavailable ? 503 : 502).json({ error: message });
  }
});

router.patch('/projects/:id/agent-profile', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (!isPrivilegedRole(role) && (!userId || !(await isProjectOwner(req.params.id, userId)))) return res.status(403).json({ error: 'only owner, admin or operator can update teammate' });
    const clean = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) || null : null;
    const profile = req.body || {};
    const disabledSkills = Array.isArray(profile.disabledSkills)
      ? Array.from(new Set(profile.disabledSkills.filter((item: unknown): item is string => typeof item === 'string').map((item: string) => item.trim()).filter(Boolean))).slice(0, 500)
      : null;
    await execute(
      `INSERT INTO project_agent_profiles(project_id,display_name,face,role,tagline,promise,tool_policy)
       VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $7::jsonb IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('disabledSkills',$7::jsonb) END)
       ON CONFLICT(project_id) DO UPDATE SET
         display_name=EXCLUDED.display_name,
         face=EXCLUDED.face,
         role=EXCLUDED.role,
         tagline=EXCLUDED.tagline,
         promise=EXCLUDED.promise,
         tool_policy=CASE WHEN $7::jsonb IS NULL THEN project_agent_profiles.tool_policy ELSE project_agent_profiles.tool_policy || jsonb_build_object('disabledSkills',$7::jsonb) END,
         instruction_version=project_agent_profiles.instruction_version+1,
         updated_at=NOW()`,
      [req.params.id, clean(profile.displayName,120), clean(profile.face,160), clean(profile.role,240), clean(profile.tagline,500), clean(profile.promise,500), disabledSkills ? JSON.stringify(disabledSkills) : null],
    );
    const project = await getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'project not found' });
    res.json(project);
    broadcastToProjectMembers(project.id, { type: 'project_updated', project });
  } catch (err:any) { res.status(500).json({ error: err?.message || 'failed to update teammate' }); }
});

router.patch('/projects/:id', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    // admin/operator 는 모든 프로젝트 수정 가능 (2026-05-04 결정)
    if (!isPrivilegedRole(role) && userId) {
      if (!(await isProjectOwner(req.params.id as string, userId))) {
        return res.status(403).json({ error: 'only owner, admin or operator can update project' });
      }
    }
    const project = await updateProject(req.params.id as string, req.body);
    if (!project) return res.status(404).json({ error: 'project not found' });
    res.json(project);

    // Realtime: push updated metadata to all project members
    broadcastToProjectMembers(project.id, { type: 'project_updated', project });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

async function retireProjectRoute(req: any, res: any) {
  try {
    const userId = Number(req.user?.userId);
    const role = req.user?.role;
    const projectId = req.params.id as string;
    if (!Number.isInteger(userId) || userId <= 0) return res.status(401).json({ error: 'Auth required' });
    if (!isPrivilegedRole(role) && !(await isProjectOwner(projectId, userId))) {
      return res.status(403).json({ error: 'only owner, admin or operator can retire an agent' });
    }
    const members = await getProjectMembers(projectId).catch(() => []);
    // External runtime must be quiesced before the durable lifecycle state changes.
    // Fail closed: a container that cannot be stopped keeps the Agent active.
    const boxes = await query<{ id: number }>('SELECT id FROM project_runtime_boxes WHERE project_id = $1', [projectId]);
    if (boxes.length > 0) {
      const { stopBox } = await import('../services/runtime-box/runtime-box-manager.js');
      for (const box of boxes) await stopBox(box.id, 'stopped');
    }
    const project = await retireProject(projectId, userId, typeof req.body?.reason === 'string' ? req.body.reason : undefined);
    if (!project) return res.status(404).json({ error: 'project not found' });
    res.json({ ok: true, project });
    const payload = { type: 'project_deleted', projectId, lifecycleStatus: 'retired' };
    for (const uid of new Set(members.map(member => member.userId))) broadcastToUser(uid, payload);
    if (!members.some(member => member.userId === userId)) broadcastToUser(userId, payload);
  } catch (err: any) {
    res.status(/only an active/.test(err.message) ? 409 : 500).json({ error: err.message });
  }
}

router.post('/projects/:id/retire', retireProjectRoute);
// Compatibility boundary: old clients now retire instead of hard-deleting.
router.delete('/projects/:id', retireProjectRoute);

router.get('/admin/agents', async (req, res) => {
  try {
    const role = (req as any).user?.role;
    if (!isAdminOrOperator(role)) return res.status(403).json({ error: 'admin/operator only' });
    const status = req.query.status === 'retired' ? 'retired' : 'active';
    res.json({ status, agents: await listAdminAgents(status) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/agents/:id/purge/preview', async (req, res) => {
  try {
    const user = (req as any).user;
    if (!isAdminOrOperator(user?.role)) return res.status(403).json({ error: 'admin/operator only' });
    const preview = await previewAgentPurge(req.params.id as string, Number(user.userId));
    if (!preview) return res.status(404).json({ error: 'agent not found' });
    res.json(preview);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/agents/:id/purge/apply', async (req, res) => {
  try {
    const user = (req as any).user;
    if (!isAdminOrOperator(user?.role)) return res.status(403).json({ error: 'admin/operator only' });
    const job = await createAgentPurgeJob({
      projectId: req.params.id as string, actorUserId: Number(user.userId),
      intentId: String(req.body?.intentId ?? ''), proposalHash: String(req.body?.proposalHash ?? ''),
      typedName: String(req.body?.typedName ?? ''), confirmed: req.body?.confirmed === true ? true : false as never,
    });
    res.status(202).json({ jobId: job.id, status: job.status });
    setImmediate(() => runAgentPurgeJob(job.id).catch(err => console.error(`[agent-purge] job ${job.id} failed:`, err.message)));
  } catch (err: any) {
    const status = /REQUIRED|MISMATCH|BLOCKERS|RETIRED|CONSUMED/.test(err.message) ? 409 : 500;
    res.status(status).json({ error: err.message });
  }
});

router.get('/admin/agent-purge-jobs/:jobId', async (req, res) => {
  const role = (req as any).user?.role;
  if (!isAdminOrOperator(role)) return res.status(403).json({ error: 'admin/operator only' });
  const job = await getAgentPurgeJob(req.params.jobId as string);
  if (!job) return res.status(404).json({ error: 'purge job not found' });
  res.json(job);
});

router.post('/admin/agent-purge-jobs/:jobId/retry', async (req, res) => {
  try {
    const role = (req as any).user?.role;
    if (!isAdminOrOperator(role)) return res.status(403).json({ error: 'admin/operator only' });
    const jobId = req.params.jobId as string;
    const job = await getAgentPurgeJob(jobId);
    if (!job) return res.status(404).json({ error: 'purge job not found' });
    res.status(202).json({ jobId, status: 'retrying' });
    setImmediate(() => runAgentPurgeJob(jobId).catch(err => console.error(`[agent-purge] retry ${jobId} failed:`, err.message)));
  } catch (err: any) { res.status(409).json({ error: err.message }); }
});

router.post('/projects/:id/restore', async (req, res) => {
  try {
    const userId = Number((req as any).user?.userId);
    const role = (req as any).user?.role;
    const projectId = req.params.id as string;
    if (!Number.isInteger(userId) || userId <= 0) return res.status(401).json({ error: 'Auth required' });
    if (!isPrivilegedRole(role) && !(await isProjectOwner(projectId, userId))) {
      return res.status(403).json({ error: 'only owner, admin or operator can restore an agent' });
    }
    const project = await restoreProject(projectId);
    if (!project) return res.status(404).json({ error: 'project not found' });
    res.json({ ok: true, project });
    broadcastToProjectMembers(projectId, { type: 'project_updated', project });
  } catch (err: any) {
    res.status(/only a retired/.test(err.message) ? 409 : 500).json({ error: err.message });
  }
});

// ───── Project Members ─────

router.get('/projects/:id/members', async (req, res) => {
  const userId = (req as any).user?.userId;
  const role = (req as any).user?.role;
  const projectId = req.params.id as string;
  // Any member, owner, or admin can view members
  if (role !== 'admin' && userId) {
    const project = await getProject(projectId);
    if (!project) return res.status(404).json({ error: 'project not found' });
    if (project.userId !== userId && !(await isProjectMember(projectId, userId))) {
      return res.status(403).json({ error: 'not a member' });
    }
  }
  res.json(await getProjectMembers(projectId));
});

router.post('/projects/:id/members', async (req, res) => {
  const userId = (req as any).user?.userId;
  const role = (req as any).user?.role;
  const projectId = req.params.id as string;

  // 2026-05-04: admin/operator 는 owner 가 아니어도 멤버 add 가능
  // (decisions/2026-05-04-five-role-model.md — 회사 운영자가 인력 배치 책임)
  if (!isPrivilegedRole(role) && !(await isProjectOwner(projectId, userId))) {
    return res.status(403).json({ error: 'only owner, admin or operator can add members' });
  }

  const { userId: targetUserId } = req.body;

  if (!targetUserId || typeof targetUserId !== 'number') {
    return res.status(400).json({ error: 'userId required' });
  }

  await addProjectMember(projectId, targetUserId, 'member');
  res.json({ ok: true });

  // Realtime: notify existing members + the invitee (who may not be in
  // project_members cache yet — pass explicitly as extraUserId).
  try {
    const project = await getProject(projectId);
    if (project) {
      await broadcastToProjectMembers(
        projectId,
        { type: 'project_member_added', projectId, userId: targetUserId, project },
        targetUserId,
      );
    }
  } catch { /* best-effort */ }
});

router.delete('/projects/:id/members/:uid', async (req, res) => {
  const userId = (req as any).user?.userId;
  const role = (req as any).user?.role;
  const projectId = req.params.id as string;
  const targetUserId = parseInt(req.params.uid as string);

  // 2026-05-04: admin/operator 는 owner 가 아니어도 멤버 remove 가능
  if (!isPrivilegedRole(role) && !(await isProjectOwner(projectId, userId))) {
    return res.status(403).json({ error: 'only owner, admin or operator can remove members' });
  }

  // Snapshot members BEFORE removal so we can notify the one being kicked.
  let priorMemberIds: number[] = [];
  try {
    const priorMembers = await getProjectMembers(projectId);
    priorMemberIds = Array.from(new Set(priorMembers.map(m => m.userId)));
  } catch { /* best-effort */ }

  const ok = await removeProjectMember(projectId, targetUserId);
  if (!ok) return res.status(400).json({ error: 'cannot remove last owner' });
  res.json({ ok: true });

  // Realtime: tell remaining members + the removed user. The removed user
  // gets a distinct payload so the frontend can drop the project from their sidebar.
  const payload = { type: 'project_member_removed', projectId, userId: targetUserId };
  for (const uid of priorMemberIds) broadcastToUser(uid, payload);
  // Make sure the removed user gets the notice even if they were already gone from cache.
  if (!priorMemberIds.includes(targetUserId)) {
    broadcastToUser(targetUserId, payload);
  }
});

// ───── User Search (for member invitation) ─────

router.get('/users/search', async (req, res) => {
  // NOTE on limits: the invite dropdown filters by `!memberIds.includes(u.id)`
  // on the client, so the empty-query branch MUST return every active user or
  // large teams would silently lose alphabetically-late names. 1000 is a safe
  // hard cap against runaway payloads; typed-search stays at 20.
  const q = (req.query.q as string || '').trim();
  if (!q) {
    const users = await query<{ id: number; username: string }>(
      `SELECT id, username FROM users WHERE disabled = 0 ORDER BY username LIMIT 1000`
    );
    return res.json(users);
  }
  const users = await query<{ id: number; username: string }>(
    `SELECT id, username FROM users WHERE disabled = 0 AND username LIKE $1 ORDER BY username LIMIT 20`,
    [`%${q}%`]
  );
  res.json(users);
});

router.post('/projects/reorder', async (req, res) => {
  try {
    const { projectIds } = req.body;
    if (!Array.isArray(projectIds)) return res.status(400).json({ error: 'projectIds array required' });
    await reorderProjects(projectIds);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sessions/:id/move', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    const { projectId } = req.body;

    // 1. Verify session ownership (only owner or admin can move)
    if (userId) {
      const access = await canAccessSession(req.params.id as string, userId, role);
      if (!access.allowed) return res.status(access.status).json({ error: access.message });
    }

    // 2. Verify target project membership (must be member to move into)
    if (projectId) {
      const projAccess = await canCreateInProject(projectId, userId, role);
      if (!projAccess.allowed) return res.status(projAccess.status).json({ error: projAccess.message });
    }

    const ok = await moveSessionToProject(req.params.id as string, projectId ?? null);
    if (!ok) return res.status(404).json({ error: 'session or project not found' });
    // Broadcast so all connected clients update their session lists
    broadcast({ type: 'session_moved', sessionId: req.params.id as string, projectId: projectId ?? null });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ───── Kanban Tasks ─────
router.get('/tasks', async (req, res) => {
  try {
    const tasks = await getTasks((req as any).user?.userId, (req as any).user?.role);
    res.json(tasks);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/tasks/meta', async (req, res) => {
  try {
    const cwds = await getDistinctCwds((req as any).user?.userId);
    res.json({ cwds });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/tasks', async (req, res) => {
  try {
    const { title, description, cwd, engine, model, scheduledAt, scheduleCron, scheduleEnabled, workflow, parentTaskId, projectId, reportPolicy } = req.body;
    if (!title || !cwd) return res.status(400).json({ error: 'title and cwd required' });
    // Validate cron interval range (1..10080 min) — reject early so a malformed
    // cron from API/AI can't sit in DB and silently fail at scheduler tick.
    if (scheduleCron) {
      try {
        const parsed = typeof scheduleCron === 'string' ? JSON.parse(scheduleCron) : scheduleCron;
        const { validateCron } = await import('../services/task/task-scheduler.js');
        validateCron(parsed);
      } catch (cronErr: any) {
        return res.status(400).json({ error: cronErr.message });
      }
    }
    const schedule = (scheduledAt || scheduleCron || scheduleEnabled)
      ? { scheduledAt, scheduleCron, scheduleEnabled }
      : undefined;
    // Whitelist policy values — reject anything else so a typo can't
    // silently degrade to DB DEFAULT.
    const VALID_POLICIES = ['silent', 'notification'] as const;
    const safePolicy = VALID_POLICIES.includes(reportPolicy) ? reportPolicy : undefined;
    // Whitelist engine values — same rationale as policy. Anything else falls
    // through to createTask's default 'claude'. Added 2026-05-17 (W2).
    const VALID_ENGINES = ['claude', 'pi', 'local'] as const;
    const safeEngine = VALID_ENGINES.includes(engine) ? engine : undefined;
    const task = await createTask(title, description || '', cwd, (req as any).user?.userId, model, schedule, workflow, parentTaskId, projectId, undefined, safePolicy, safeEngine);
    // Broadcast to all connected clients so kanban boards update in real-time
    broadcast({ type: 'task_created', task });
    res.json(task);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/tasks/:id', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (userId) {
      const access = await canAccessTask(req.params.id as string, userId, role);
      if (!access.allowed) return res.status(access.status).json({ error: access.message });
    }
    // Same cron validation as POST — PATCH can replace scheduleCron too.
    if (req.body?.scheduleCron) {
      try {
        const parsed = typeof req.body.scheduleCron === 'string' ? JSON.parse(req.body.scheduleCron) : req.body.scheduleCron;
        const { validateCron } = await import('../services/task/task-scheduler.js');
        validateCron(parsed);
      } catch (cronErr: any) {
        return res.status(400).json({ error: cronErr.message });
      }
    }
    const task = await updateTask(req.params.id as string, req.body);
    if (!task) return res.status(404).json({ error: 'task not found' });
    res.json(task);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/tasks/:id', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (userId) {
      const access = await canAccessTask(req.params.id as string, userId, role);
      if (!access.allowed) return res.status(access.status).json({ error: access.message });
    }
    const ok = await deleteTask(req.params.id as string);
    if (!ok) return res.status(404).json({ error: 'task not found' });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/tasks/:id/children', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (userId) {
      const access = await canAccessTask(req.params.id as string, userId, role);
      if (!access.allowed) return res.status(access.status).json({ error: access.message });
    }
    const children = await getChildTasks(req.params.id as string);
    res.json(children);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/tasks/:id/cleanup-worktree', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (userId) {
      const access = await canAccessTask(req.params.id as string, userId, role);
      if (!access.allowed) return res.status(access.status).json({ error: access.message });
    }
    const task = await getTask(req.params.id as string);
    if (!task) return res.status(404).json({ error: 'task not found' });
    if (task.status === 'in_progress') return res.status(400).json({ error: 'cannot cleanup worktree for running task' });
    if (!task.worktreePath) return res.status(400).json({ error: 'task has no worktree' });

    const ok = removeWorktree(task.worktreePath);
    if (ok) {
      await updateTask(req.params.id as string, { worktreePath: null });
    }
    res.json({ success: ok });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/tasks/reorder', async (req, res) => {
  try {
    // reorder: verify all tasks belong to user or user has access
    // For now, only admin can reorder arbitrary tasks; others limited to own
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    const { taskIds, status } = req.body;
    if (!taskIds || !status) return res.status(400).json({ error: 'taskIds and status required' });
    if (role !== 'admin' && userId && taskIds.length > 0) {
      // Spot-check first task for access
      const access = await canAccessTask(taskIds[0], userId, role);
      if (!access.allowed) return res.status(access.status).json({ error: access.message });
    }
    await reorderTasks(taskIds, status);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── History (archived sessions + tasks) ──────────────────
router.get('/history', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    const sessions = await getArchivedSessions(userId, role);
    const tasks = await getArchivedTasks(userId);
    res.json({ sessions, tasks });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sessions/:id/restore', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (userId) {
      const access = await canDeleteSession(req.params.id, userId, role);
      if (!access.allowed) return res.status(access.status).json({ error: access.message });
    }
    const ok = await restoreSession(req.params.id as string);
    if (!ok) return res.status(404).json({ error: 'session not found' });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/sessions/:id/permanent', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (userId) {
      const access = await canDeleteSession(req.params.id, userId, role);
      if (!access.allowed) return res.status(access.status).json({ error: access.message });
    }
    const ok = await permanentlyDeleteSession(req.params.id as string);
    if (!ok) return res.status(404).json({ error: 'session not found' });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/tasks/:id/restore', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (userId) {
      const access = await canAccessTask(req.params.id as string, userId, role);
      if (!access.allowed) return res.status(access.status).json({ error: access.message });
    }
    const ok = await restoreTask(req.params.id as string);
    if (!ok) return res.status(404).json({ error: 'task not found' });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/tasks/:id/permanent', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (userId) {
      const access = await canAccessTask(req.params.id as string, userId, role);
      if (!access.allowed) return res.status(access.status).json({ error: access.message });
    }
    const ok = await permanentlyDeleteTask(req.params.id as string);
    if (!ok) return res.status(404).json({ error: 'task not found' });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Chat Rooms (PG) ──────────────────────────────────────────────────

router.get('/rooms', authMiddleware, async (req, res) => {
  try {
    const { isPgEnabled } = await import('../db/pg.js');
    if (!isPgEnabled()) return res.json({ rooms: [], pgEnabled: false, unreadCounts: {} });
    const { listRooms, getUnreadCounts } = await import('../services/room/room-manager.js');
    const userId = (req as any).user.userId;
    const userRole = (req as any).user.role;
    const [rooms, unreadMap] = await Promise.all([
      listRooms(userId, userRole),
      getUnreadCounts(userId),
    ]);
    // Convert Map to plain object for JSON serialization
    const unreadCounts: Record<string, number> = {};
    for (const [roomId, count] of unreadMap) {
      if (count > 0) unreadCounts[roomId] = count;
    }
    res.json({ rooms, pgEnabled: true, unreadCounts });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/rooms', authMiddleware, async (_req, res) => {
  res.status(410).json({
    error: 'Internal channels are retired. Use AI sessions and Notifications instead.',
    code: 'INTERNAL_CHANNEL_RETIRED',
  });
});

// P4: retain authenticated GET archive/read paths, but stop every subsequent
// room mutation before upload, membership, webhook-token, or manager code runs.
router.use('/rooms/:id', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  return res.status(410).json({
    error: 'Internal channels are read-only and retired. Use AI sessions, Work, and Notifications instead.',
    code: 'INTERNAL_CHANNEL_RETIRED',
  });
});

router.get('/rooms/:id/archive', authMiddleware, async (req, res) => {
  try {
    const roomId = req.params.id as string;
    const userId = (req as any).user.userId;
    const role = (req as any).user.role;
    const access = await canAccessRoom(roomId, userId, role);
    if (!access.allowed) return res.status(access.status).json({ error: access.message });
    const { getInternalChannelArchiveManifest } = await import('../services/room/internal-channel-archive.js');
    const archive = await getInternalChannelArchiveManifest(roomId);
    if (!archive) return res.status(404).json({ error: 'Room not found' });
    res.setHeader('Content-Disposition', `attachment; filename="internal-channel-${roomId}-archive.json"`);
    res.json(archive);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get('/rooms/:id/archive/messages', authMiddleware, async (req, res) => {
  try {
    const roomId = req.params.id as string;
    const userId = (req as any).user.userId;
    const role = (req as any).user.role;
    const access = await canAccessRoom(roomId, userId, role);
    if (!access.allowed) return res.status(access.status).json({ error: access.message });
    const requestedLimit = Number.parseInt(String(req.query.limit ?? '200'), 10);
    const { getInternalChannelArchiveMessages } = await import('../services/room/internal-channel-archive.js');
    res.json(await getInternalChannelArchiveMessages(roomId, {
      limit: Number.isFinite(requestedLimit) ? requestedLimit : 200,
      before: typeof req.query.before === 'string' ? req.query.before : undefined,
      after: typeof req.query.after === 'string' ? req.query.after : undefined,
    }));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get('/rooms/:id', authMiddleware, async (req, res) => {
  try {
    const { getRoom, getMembers, isMember } = await import('../services/room/room-manager.js');
    const room = await getRoom(req.params.id as string);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const userId = (req as any).user.userId;
    if (!(await isMember(req.params.id as string, userId))) return res.status(403).json({ error: 'Not a member' });
    const members = await getMembers(req.params.id as string);
    res.json({ ...room, members });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get('/rooms/:id/resources', authMiddleware, async (req, res) => {
  try {
    const roomId = req.params.id as string;
    const userId = (req as any).user.userId;
    const role = (req as any).user.role;
    const access = await canAccessRoom(roomId, userId, role);
    if (!access.allowed) return res.status(access.status).json({ error: access.message });
    const { listChannelResourceLinks } = await import('../services/room/channel-resource-links.js');
    res.json({ resources: await listChannelResourceLinks(roomId) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});





router.get('/rooms/:id/shared-files', authMiddleware, async (req, res) => {
  try {
    const roomId = req.params.id as string;
    const userId = (req as any).user.userId;
    const role = (req as any).user.role;
    const access = await canAccessRoom(roomId, userId, role);
    if (!access.allowed) return res.status(access.status).json({ error: access.message });
    const { listChannelSharedFiles } = await import('../services/room/channel-shared-files.js');
    res.json({ files: await listChannelSharedFiles(roomId) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});









router.get('/rooms/:id/agents', authMiddleware, async (req, res) => {
  try {
    const roomId = req.params.id as string;
    const userId = (req as any).user.userId;
    const role = (req as any).user.role;
    const access = await canAccessRoom(roomId, userId, role);
    if (!access.allowed) return res.status(access.status).json({ error: access.message });
    const { listChannelAgents } = await import('../services/room/channel-agent-memberships.js');
    res.json({ agents: await listChannelAgents(roomId) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get('/rooms/:id/invitable-agents', authMiddleware, async (req, res) => {
  try {
    const roomId = req.params.id as string;
    const userId = (req as any).user.userId;
    const role = (req as any).user.role;
    const access = await canAccessRoom(roomId, userId, role);
    if (!access.allowed) return res.status(access.status).json({ error: access.message });
    const { getMemberRole } = await import('../services/room/room-manager.js');
    const memberRole = await getMemberRole(roomId, userId);
    if (!isPrivilegedRole(role) && memberRole !== 'owner' && memberRole !== 'admin') {
      return res.status(403).json({ error: 'Only channel owners or admins can manage Agents' });
    }
    const projects = await getProjects(userId, role);
    const { listChannelAgents } = await import('../services/room/channel-agent-memberships.js');
    const currentIds = new Set((await listChannelAgents(roomId)).map((agent) => agent.projectId));
    const ids = projects.map((project: any) => project.id).filter((id: string) => !currentIds.has(id));
    if (ids.length === 0) return res.json({ agents: [] });
    const rows = await query<any>(
      `SELECT p.id AS project_id,
              COALESCE(NULLIF(pap.display_name, ''), p.name) AS display_name,
              COALESCE(NULLIF(pap.face, ''), '✨') AS face,
              pap.tagline
         FROM projects p
         LEFT JOIN project_agent_profiles pap ON pap.project_id = p.id
        WHERE p.id = ANY($1::text[])
          AND COALESCE(pap.status, 'active') IN ('active', 'ready')
        ORDER BY COALESCE(NULLIF(pap.display_name, ''), p.name)`,
      [ids],
    );
    res.json({ agents: rows.map((row: any) => ({ projectId: row.project_id, displayName: row.display_name, face: row.face, tagline: row.tagline || null })) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});





router.get('/rooms/:id/invitable-users', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (userId) {
      const access = await canAccessRoom(req.params.id as string, userId, role);
      if (!access.allowed) return res.status(access.status).json({ error: access.message });
    }
    const { getMembers } = await import('../services/room/room-manager.js');
    const members = await getMembers(req.params.id as string);
    const memberUserIds = new Set(members.map(m => m.userId));

    // Get all active users, exclude current members
    const allUsers = await query<{ id: number; username: string; role: string }>(
      'SELECT id, username, role FROM users WHERE disabled = 0 ORDER BY username'
    );

    const invitable = allUsers
      .filter(u => !memberUserIds.has(u.id))
      .map(u => ({ id: u.id, username: u.username, role: u.role }));

    res.json({ users: invitable });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get('/rooms/:id/membership-events', authMiddleware, async (req, res) => {
  try {
    const roomId = req.params.id as string;
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    const access = await canAccessRoom(roomId, userId, role);
    if (!access.allowed) return res.status(access.status).json({ error: access.message });
    const { getMemberRole, getMembershipEvents } = await import('../services/room/room-manager.js');
    const memberRole = await getMemberRole(roomId, userId);
    if (!isPrivilegedRole(role) && memberRole !== 'owner' && memberRole !== 'admin') {
      return res.status(403).json({ error: 'Only channel owners or admins can review membership history' });
    }
    const limit = Number.parseInt(String(req.query.limit || '100'), 10);
    res.json({ events: await getMembershipEvents(roomId, Number.isFinite(limit) ? limit : 100) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});





router.get('/rooms/:id/messages', authMiddleware, async (req, res) => {
  try {
    const { getMessages: getRoomMessages, isMember } = await import('../services/room/room-manager.js');
    const userId = (req as any).user.userId;
    if (!(await isMember(req.params.id as string, userId))) return res.status(403).json({ error: 'Not a member' });
    const messages = await getRoomMessages(req.params.id as string, {
      limit: parseInt(req.query.limit as string) || 50,
      before: req.query.before as string,
      after: req.query.after as string,
    });
    res.json({ messages });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Legacy webhook metadata remains readable for archive/migration review.


router.get('/rooms/:id/webhook-tokens', authMiddleware, async (req, res) => {
  try {
    const roomId = req.params.id as string;
    const userId = (req as any).user.userId;
    const userRole = (req as any).user.role;

    const { getMemberRole } = await import('../services/room/room-manager.js');
    const memberRole = await getMemberRole(roomId, userId);
    const isPrivileged = userRole === 'admin' || userRole === 'operator';
    const isRoomOwner = memberRole === 'owner';
    if (!isPrivileged && !isRoomOwner) {
      return res.status(403).json({ error: 'Only admin/operator or room owner can list tokens' });
    }

    const tokens = await query<any>(
      `SELECT label, created_at, last_used_at, revoked_at
         FROM room_webhook_tokens
        WHERE room_id = $1
        ORDER BY created_at DESC`,
      [roomId],
    );
    res.json({ tokens: tokens.map((token: any) => ({
      label: token.label,
      createdAt: token.created_at,
      lastUsedAt: token.last_used_at ?? null,
      status: token.revoked_at ? 'revoked' : 'retired',
    })) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});



router.get('/notifications', authMiddleware, async (req, res) => {
  try {
    const { isPgEnabled } = await import('../db/pg.js');
    if (!isPgEnabled()) return res.json({ notifications: [], unreadCount: 0 });
    const { getNotifications, getUnreadCount } = await import('../services/room/room-manager.js');
    const userId = (req as any).user.userId;
    const unreadOnly = req.query.unreadOnly === 'true';
    const notifications = await getNotifications(userId, { unreadOnly });
    const unreadCount = await getUnreadCount(userId);
    res.json({ notifications, unreadCount });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/notifications/:id/read', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const notifId = req.params.id as string;
    const { markNotificationRead, getUnreadCount } = await import('../services/room/room-manager.js');
    await markNotificationRead(notifId, userId);
    res.json({ success: true });

    // Realtime: sync read state across this user's tabs/devices.
    // Include the fresh unreadCount so each tab can update its badge directly.
    if (userId) {
      try {
        const unreadCount = await getUnreadCount(userId);
        broadcastToUser(userId, {
          type: 'notification_read',
          notificationId: notifId,
          unreadCount,
        });
      } catch { /* best-effort */ }
    }
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/notifications/read-all', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const { markAllNotificationsRead } = await import('../services/room/room-manager.js');
    const count = await markAllNotificationsRead(userId);
    res.json({ success: true, count });

    // Realtime: sync read-all state across this user's tabs/devices.
    broadcastToUser(userId, {
      type: 'notification_read_all',
      unreadCount: 0,
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get('/notification-preferences', authMiddleware, async (req, res) => {
  try {
    const { isPgEnabled } = await import('../db/pg.js');
    if (!isPgEnabled()) return res.json({ global: {}, events: [], projects: [] });
    const userId = (req as any).user.userId;
    const role = (req as any).user.role || 'member';
    const { getNotificationPreferences } = await import('../services/notifications/notification-preferences.js');
    res.json(await getNotificationPreferences(userId, role));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.put('/notification-preferences', authMiddleware, async (req, res) => {
  try {
    const { isPgEnabled } = await import('../db/pg.js');
    if (!isPgEnabled()) return res.status(503).json({ error: 'PostgreSQL is required for notification preferences' });
    const userId = (req as any).user.userId;
    const role = (req as any).user.role || 'member';
    const { updateNotificationPreferences } = await import('../services/notifications/notification-preferences.js');
    res.json(await updateNotificationPreferences(userId, req.body ?? {}, role));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get('/push/vapid-public-key', authMiddleware, async (_req, res) => {
  try {
    const { isWebPushConfigured, getWebPushPublicKey } = await import('../services/notifications/web-push-sender.js');
    res.json({ configured: isWebPushConfigured(), publicKey: getWebPushPublicKey() || null });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get('/push/subscriptions', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const { listPushSubscriptions } = await import('../services/notifications/push-subscriptions.js');
    const subscriptions = await listPushSubscriptions(userId, true);
    res.json({ subscriptions: subscriptions.map(({ p256dh, auth, ...safe }) => safe) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/push/subscribe', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const { endpoint, keys, userAgent, deviceLabel, platform } = req.body ?? {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'endpoint, keys.p256dh, keys.auth are required' });
    }
    const { upsertPushSubscription } = await import('../services/notifications/push-subscriptions.js');
    const sub = await upsertPushSubscription(userId, { endpoint, keys, userAgent, deviceLabel, platform });
    res.json({ ok: true, subscription: { ...sub, p256dh: undefined, auth: undefined } });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete('/push/subscribe', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const { endpoint } = req.body ?? {};
    if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
    const { disablePushSubscriptionByEndpoint } = await import('../services/notifications/push-subscriptions.js');
    const ok = await disablePushSubscriptionByEndpoint(userId, endpoint);
    res.json({ ok });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete('/push/subscriptions/:id', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const { disablePushSubscriptionById } = await import('../services/notifications/push-subscriptions.js');
    const ok = await disablePushSubscriptionById(userId, req.params.id as string);
    res.json({ ok });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/push/test', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const { sendWebPushToUser } = await import('../services/notifications/web-push-sender.js');
    const notificationId = `push-test-${Date.now()}`;
    const sentAt = new Intl.DateTimeFormat('ko-KR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: 'Asia/Seoul',
    }).format(new Date());
    const result = await sendWebPushToUser(userId, {
      notificationId,
      title: 'Tower 테스트 알림',
      body: `${sentAt} 발송됨 · 브라우저/PWA 알림이 정상 작동합니다`,
      actionUrl: '/settings?tab=notifications',
      tag: notificationId,
      type: 'system.announcement',
    });
    res.json({ ok: true, ...result });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// (Heartbeat 5 endpoints 제거 — 2026-04-28-heartbeat-deprecation.md Phase 4-B)

/* ── Help docs ── */

const _apiDirname = path.dirname(new URL(import.meta.url).pathname);
// Tower repo root: from packages/backend/routes/ go up 3 levels, or from dist/ go up 4
const _towerRoot = _apiDirname.includes('dist')
  ? path.resolve(_apiDirname, '..', '..', '..', '..')
  : path.resolve(_apiDirname, '..', '..', '..');
const HELP_DIR = path.join(_towerRoot, 'docs', 'help');

router.get('/help', async (req, res) => {
  try {
    const lang = (req.query.lang === 'ko') ? 'ko' : 'en';
    const helpDir = path.join(HELP_DIR, lang);
    const files = await fsPromises.readdir(helpDir);
    const mdFiles = files.filter((f) => f.endsWith('.md'));
    const topics: { slug: string; title: string; icon: string; order: number }[] = [];
    for (const file of mdFiles) {
      const raw = await fsPromises.readFile(path.join(helpDir, file), 'utf-8');
      const frontmatterMatch = raw.match(/^---\n([\s\S]*?)\n---/);
      let title = file.replace(/\.md$/, '');
      let icon = '📄';
      let order = 99;
      if (frontmatterMatch) {
        const fm = frontmatterMatch[1];
        const titleMatch = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m);
        const iconMatch = fm.match(/^icon:\s*["']?(.+?)["']?\s*$/m);
        const orderMatch = fm.match(/^order:\s*(\d+)/m);
        if (titleMatch) title = titleMatch[1];
        if (iconMatch) icon = iconMatch[1];
        if (orderMatch) order = parseInt(orderMatch[1]);
      }
      topics.push({ slug: file.replace(/\.md$/, ''), title, icon, order });
    }
    topics.sort((a, b) => a.order - b.order);
    res.json(topics);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get('/help/:slug', async (req, res) => {
  try {
    const lang = (req.query.lang === 'ko') ? 'ko' : 'en';
    const helpDir = path.join(HELP_DIR, lang);
    const slug = req.params.slug.replace(/[^a-zA-Z0-9_-]/g, '');
    const filePath = path.join(helpDir, `${slug}.md`);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Help topic not found' });
    }
    const raw = await fsPromises.readFile(filePath, 'utf-8');
    // Strip YAML frontmatter
    const content = raw.replace(/^---\n[\s\S]*?\n---\n*/, '');
    res.type('text/plain').send(content);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ───── Publishing & Deploy Engine ─────
import {
  deploy, listDeployments, deleteDeployment, detectCodeType,
  getPublishStatus, getTrafficStats,
  updateSiteAccess, updateSitesAccessBulk,
  archiveSite, unarchiveSite, archiveSitesBulk,
  setSiteTags, modifySitesTagsBulk,
  type Access,
} from '../services/deploy/deploy-engine.js';
import { publishViaGateway, checkGatewayStatus } from '../services/publish-client.js';

// Publish status (replaces Hub /health) — returns sites/apps with live status checks
router.get('/publish/status', authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const status = await getPublishStatus();

    // Publishing Hub is a project workspace, not a fleet-wide catalog. Every
    // signed-in user (including admin/operator) sees only assets belonging to
    // projects they are actually a member/creator of. Fleet-wide inspection, if
    // needed, belongs in a separate administration surface.
    const membershipProjectIds = user?.userId
      ? await getProjectMembershipIds(user.userId)
      : [];
    // Manifest `project` is the workspace folder key (e.g. test-project-3c00cc13),
    // while membership rows use DB project UUIDs. Convert before filtering.
    const { loadProjectFolderKeyMap } = await import('../services/publishing/project-display.js');
    const folderById = await loadProjectFolderKeyMap();
    const allowed = new Set(membershipProjectIds.map((id) => folderById[id] || id));
    status.sites = status.sites.filter((s: any) => s.project && allowed.has(s.project));
    status.apps = status.apps.filter((a: any) => a.project && allowed.has(a.project));
    status.projects = Object.fromEntries(
      Object.entries(status.projects).filter(([projectKey]) => allowed.has(projectKey)),
    );

    res.json(status);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Publish traffic stats (replaces Hub /stats) — parses nginx access log
router.get('/publish/stats', authMiddleware, async (_req, res) => {
  try {
    const stats = await getTrafficStats();
    res.json(stats);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Publish info — returns tower role + config for frontend UI
router.get('/publish/info', authMiddleware, async (_req, res) => {
  const info: Record<string, unknown> = {
    role: config.towerRole,
    gatewayConfigured: config.towerRole === 'managed' && !!config.publishGatewayUrl,
  };
  // For managed mode, show gateway URL (not the key)
  if (config.towerRole === 'managed' && config.publishGatewayUrl) {
    info.gatewayUrl = config.publishGatewayUrl;
  }
  // For full mode, indicate gateway is serving
  if (config.towerRole === 'full') {
    info.gatewayEnabled = true;
  }
  res.json(info);
});

// Gateway status for self-hosted VMs — pings the central gateway and returns connectivity + quota info
router.get('/publish/gateway-status', authMiddleware, async (req, res) => {
  if (config.towerRole !== 'managed') {
    return res.json({ connected: false, error: 'Not a managed server', checkedAt: new Date().toISOString() });
  }
  try {
    const force = req.query.force === 'true';
    const status = await checkGatewayStatus(force);
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ connected: false, error: err.message, checkedAt: new Date().toISOString() });
  }
});

// ── Visibility (access tier) management ──
//
// Both endpoints require admin OR operator (PR2 of the visibility redesign,
// see workspace/decisions/2026-04-29-publishing-local-first.md). Slug is never
// changed — URL stability is a hard invariant. Disk-only sites are promoted to
// manifest entries on first change so the choice persists.

const VALID_ACCESS_TIERS = ['public', 'unlisted', 'private', 'internal'] as const;
function canManageVisibility(role: string | undefined): boolean {
  return role === 'admin' || role === 'operator';
}

// PATCH /api/publish/sites/:slug/access  body: { access }
router.patch('/publish/sites/:slug/access', authMiddleware, async (req, res) => {
  const user = (req as any).user;
  if (!canManageVisibility(user?.role)) {
    return res.status(403).json({ error: 'Admin or operator required' });
  }
  const slug = String(req.params.slug || '');
  const access = (req.body?.access ?? '') as string;
  if (!VALID_ACCESS_TIERS.includes(access as any)) {
    return res.status(400).json({ error: `access must be one of ${VALID_ACCESS_TIERS.join('/')}` });
  }
  try {
    const result = await updateSiteAccess(slug, access as Access);
    if (!result.ok) return res.status(404).json({ error: result.error || 'Update failed' });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/publish/sites/access/bulk  body: { slugs: string[], access }
router.post('/publish/sites/access/bulk', authMiddleware, async (req, res) => {
  const user = (req as any).user;
  if (!canManageVisibility(user?.role)) {
    return res.status(403).json({ error: 'Admin or operator required' });
  }
  const { slugs, access } = req.body || {};
  if (!VALID_ACCESS_TIERS.includes(access)) {
    return res.status(400).json({ error: `access must be one of ${VALID_ACCESS_TIERS.join('/')}` });
  }
  if (!Array.isArray(slugs) || slugs.length === 0) {
    return res.status(400).json({ error: 'slugs (non-empty array) required' });
  }
  try {
    const result = await updateSitesAccessBulk(slugs as string[], access as Access);
    if (!result.ok) return res.status(400).json({ error: result.error || 'Bulk update failed' });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Soft-delete (archive) ──
// Archive  = take site offline without losing files. Hybrid storage: drop the
//            symlink in published/sites/. Flat storage: move folder to
//            published/_archived/<slug>__<ts>/. Manifest entry kept (archived: true).
// Unarchive= reverse the move/symlink.
// Permission: admin/operator only (matches access-tier endpoints — same risk class).

// POST /api/publish/sites/:slug/archive
router.post('/publish/sites/:slug/archive', authMiddleware, async (req, res) => {
  const user = (req as any).user;
  if (!canManageVisibility(user?.role)) {
    return res.status(403).json({ error: 'Admin or operator required' });
  }
  try {
    const result = await archiveSite(String(req.params.slug || ''));
    if (!result.ok) return res.status(404).json({ error: result.error || 'Archive failed' });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/publish/sites/:slug/unarchive
router.post('/publish/sites/:slug/unarchive', authMiddleware, async (req, res) => {
  const user = (req as any).user;
  if (!canManageVisibility(user?.role)) {
    return res.status(403).json({ error: 'Admin or operator required' });
  }
  try {
    const result = await unarchiveSite(String(req.params.slug || ''));
    if (!result.ok) return res.status(400).json({ error: result.error || 'Restore failed' });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/publish/sites/archive/bulk  body: { slugs: string[] }
router.post('/publish/sites/archive/bulk', authMiddleware, async (req, res) => {
  const user = (req as any).user;
  if (!canManageVisibility(user?.role)) {
    return res.status(403).json({ error: 'Admin or operator required' });
  }
  const { slugs } = req.body || {};
  if (!Array.isArray(slugs) || slugs.length === 0) {
    return res.status(400).json({ error: 'slugs (non-empty array) required' });
  }
  try {
    const result = await archiveSitesBulk(slugs as string[]);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Tags (free-form labels, orthogonal to access tier) ──
// Same admin/operator gate as access tier — tags affect what other users see in
// the shared Hub UI, so non-privileged callers can read but not write.

// GET /api/publish/sites/tags  → distinct tags with usage count
router.get('/publish/sites/tags', authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const status = await getPublishStatus();
    const membershipProjectIds = user?.userId ? await getProjectMembershipIds(user.userId) : [];
    const { loadProjectFolderKeyMap } = await import('../services/publishing/project-display.js');
    const folderById = await loadProjectFolderKeyMap();
    const allowed = new Set(membershipProjectIds.map((id) => folderById[id] || id));
    const counts = new Map<string, number>();
    for (const site of status.sites) {
      if (!site.project || !allowed.has(site.project)) continue;
      for (const tag of site.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    const tags = Array.from(counts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    res.json({ tags });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/publish/sites/:slug/tags  body: { tags: string[] }  (replace set)
router.patch('/publish/sites/:slug/tags', authMiddleware, async (req, res) => {
  const user = (req as any).user;
  if (!canManageVisibility(user?.role)) {
    return res.status(403).json({ error: 'Admin or operator required' });
  }
  const { tags } = req.body || {};
  if (!Array.isArray(tags)) {
    return res.status(400).json({ error: 'tags must be an array of strings' });
  }
  try {
    const result = await setSiteTags(String(req.params.slug || ''), tags as string[]);
    if (!result.ok) return res.status(404).json({ error: result.error || 'Tag update failed' });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/publish/sites/tags/bulk  body: { slugs: string[], action: 'add'|'remove'|'set', tags: string[] }
router.post('/publish/sites/tags/bulk', authMiddleware, async (req, res) => {
  const user = (req as any).user;
  if (!canManageVisibility(user?.role)) {
    return res.status(403).json({ error: 'Admin or operator required' });
  }
  const { slugs, action, tags } = req.body || {};
  if (!['add', 'remove', 'set'].includes(action)) {
    return res.status(400).json({ error: "action must be 'add' | 'remove' | 'set'" });
  }
  if (!Array.isArray(slugs) || slugs.length === 0) {
    return res.status(400).json({ error: 'slugs (non-empty array) required' });
  }
  if (!Array.isArray(tags)) {
    return res.status(400).json({ error: 'tags must be an array of strings' });
  }
  try {
    const result = await modifySitesTagsBulk(
      slugs as string[],
      action as 'add' | 'remove' | 'set',
      tags as string[],
    );
    if (!result.ok) return res.status(400).json({ error: result.error || 'Bulk tag update failed' });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Detect code type for a directory
router.post('/deploy/detect', authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const { sourceDir } = req.body;
    if (!sourceDir) return res.status(400).json({ error: 'sourceDir required' });
    const absSourceDir = path.resolve(expandHome(String(sourceDir)));
    if (!await isPathAccessible(absSourceDir, user.userId, user.role)) {
      return res.status(403).json({ error: 'sourceDir is not accessible' });
    }
    const type = await detectCodeType(absSourceDir);
    res.json({ type, recommendedTarget: type === 'static' ? 'local' : 'azure-container-apps' });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Deploy a site or app
// When TOWER_ROLE=managed, routes through the Central Publish Gateway
// When full/standalone, deploys directly via Cloudflare/Azure
router.post('/deploy', authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const { name, sourceDir, target, port, env, description, access, slug } = req.body;
    if (!name || !sourceDir) return res.status(400).json({ error: 'name and sourceDir required' });

    // Validate name format
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      return res.status(400).json({ error: 'name must be lowercase alphanumeric with hyphens' });
    }

    const absSourceDir = path.resolve(expandHome(String(sourceDir)));
    if (user.role === 'viewer') {
      return res.status(403).json({ error: 'Publishing requires project member or above' });
    }
    if (!await isPathAccessible(absSourceDir, user.userId, user.role)) {
      return res.status(403).json({ error: 'sourceDir is not accessible' });
    }
    if (!await isPathWritableByRole(absSourceDir, user.userId, user.role || 'member')) {
      return res.status(403).json({ error: 'Publishing requires a writable project sourceDir' });
    }

    const requestedTarget = target || 'local';
    if (config.towerRole === 'managed' && requestedTarget !== 'local') {
      // Explicit external/dynamic deploys still route through the Central Publish Gateway.
      const result = await publishViaGateway({ name, sourceDir: absSourceDir, type: undefined, target: requestedTarget, port, description });
      res.json(result);
    } else {
      // Local static publish copies into published/sites on this VM. This is the default
      // for full/standalone and managed project sessions alike.
      const result = await deploy({ name, sourceDir: absSourceDir, target: requestedTarget, port, env, description, access, slug });
      res.json(result);
    }
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// List all deployments
router.get('/deploy/list', authMiddleware, async (_req, res) => {
  try {
    const deployments = await listDeployments();
    res.json(deployments);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Delete a deployment
router.delete('/deploy/:type/:name', authMiddleware, async (req, res) => {
  try {
    const { type, name } = req.params;
    if (type !== 'site' && type !== 'app') return res.status(400).json({ error: 'type must be site or app' });
    const result = await deleteDeployment(name as string, type);
    res.json(result);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════
// Unified Schedules — 스케줄 통합 시스템
// ═══════════════════════════════════════════════════════════════

router.get('/schedules', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });
    const role = (req as any).user?.role;
    const schedules = await getAutomations(userId, role);
    res.json(schedules);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get('/schedules/:id', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id as string;
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });
    const schedule = await getAutomation(id);
    if (!schedule) return res.status(404).json({ error: 'not found' });
    const access = await canAccessAutomationJob(schedule, userId, role, 'read');
    if (!access.allowed) return res.status(access.status || 403).json({ error: access.message || 'forbidden' });
    res.json(schedule);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/schedules', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    const { name, prompt, description, model, mode, targetId, triggerType, cronConfig, onceAt, projectId } = req.body;
    if (!name || !prompt) return res.status(400).json({ error: 'name and prompt required' });
    if (!['spawn', 'inject'].includes(mode || 'spawn')) {
      return res.status(mode === 'channel' ? 410 : 400).json({
        error: mode === 'channel'
          ? 'channel mode is retired; execution reports are moving to Notifications'
          : 'mode must be spawn or inject',
        ...(mode === 'channel' ? { code: 'INTERNAL_CHANNEL_RETIRED' } : {}),
      });
    }
    // Same cron range guard as /api/tasks — schedules table uses the same
    // CronConfig shape (interface in unified-scheduler.ts).
    if (cronConfig) {
      try {
        const { validateCron } = await import('../services/task/task-scheduler.js');
        validateCron(cronConfig);
      } catch (cronErr: any) {
        return res.status(400).json({ error: cronErr.message });
      }
    }

    // New schedules are stored in the automations registry so the user-facing
    // 스케줄 tab has one source of truth. Legacy /api/schedules remains as a
    // compatibility entrypoint for older skills/clients.
    const schedule = await createAutomation({
      userId,
      projectId,
      name,
      description,
      prompt,
      model,
      mode: mode || 'spawn',
      targetId,
      triggerType: triggerType || 'cron',
      cronConfig,
      onceAt,
      jobType: 'ai_prompt',
      scopeType: projectId ? 'project' : 'system',
      definitionJson: { description: description || null, prompt, mode: mode || 'spawn', targetId: targetId || null, model, projectId: projectId || null },
    });
    res.json(schedule);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.patch('/schedules/:id', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id as string;
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });
    const existing = await getAutomation(id);
    if (!existing) return res.status(404).json({ error: 'not found' });
    const access = await canAccessAutomationJob(existing, userId, role, 'edit');
    if (!access.allowed) return res.status(access.status || 403).json({ error: access.message || 'forbidden' });

    const patch = classifyAutomationPatch(req.body);
    if (!patch.allowed || patch.configFields.length > 0) {
      return res.status(409).json({
        error: 'schedule config changes require the automation change-intent API',
        replacement: `/api/automations/${id}/change-intents`,
      });
    }
    if (patch.controlUpdates.enabled === undefined) {
      return res.status(400).json({ error: 'PATCH accepts only the enabled boolean control field' });
    }
    const { setAutomationEnabled } = await import('../services/task/automation-control.js');
    const schedule = await setAutomationEnabled(existing, patch.controlUpdates.enabled as boolean, userId);
    res.setHeader('Deprecation', 'true');
    res.setHeader('Link', `</api/automations/${id}/enabled>; rel="successor-version"`);
    res.json(schedule);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete('/schedules/:id', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id as string;
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });
    const existing = await getAutomation(id);
    if (!existing) return res.status(404).json({ error: 'not found' });
    const access = await canAccessAutomationJob(existing, userId, role, 'archive');
    if (!access.allowed) return res.status(access.status || 403).json({ error: access.message || 'forbidden' });

    await deleteAutomation(id);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/schedules/:id/run-now', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id as string;
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });
    const automation = await getAutomation(id);
    if (!automation) return res.status(404).json({ error: 'not found' });
    const access = await canAccessAutomationJob(automation, userId, role, 'run');
    if (!access.allowed) return res.status(access.status || 403).json({ error: access.message || 'forbidden' });

    const { runAutomationNow } = await import('../services/task/automation-control.js');
    const result = await runAutomationNow({ automation, broadcast: (type, payload) => broadcast({ type, ...payload }) });
    res.json(result);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get('/schedules/:id/runs', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id as string;
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });
    const automation = await getAutomation(id);
    if (!automation) return res.status(404).json({ error: 'not found' });
    const access = await canAccessAutomationJob(automation, userId, role, 'read');
    if (!access.allowed) return res.status(access.status || 403).json({ error: access.message || 'forbidden' });

    const limit = parseInt(req.query.limit as string) || 20;
    const runs = await getAutomationRuns(id, Math.min(limit, 100));
    res.json(runs);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════
// Automations — Tasks + Schedules 통합 API
// ═══════════════════════════════════════════════════════════════

import {
  getAutomations, getAutomation, createAutomation, updateAutomation,
  deleteAutomation, restoreAutomation, permanentlyDeleteAutomation,
  getChildAutomations, reorderAutomations, getArchivedAutomations,
  getAutomationRuns, getDistinctCwds as getAutomationCwds,
  getTemplates, createFromTemplate,
  type AutomationFilters,
} from '../services/task/automation-manager.js';
import { getAutomationRunProcessMap, getSessionProcessMap, appendProcessEvent } from '../services/process/process-map-manager.js';
import { canAccessAutomationJob, isScheduleOperator } from '../services/task/schedule-permissions.js';
import { authorizeAutomationMutation } from '../services/task/automation-mutation-policy.js';
import { applyLegacyAutomationConfig, authorizeLegacyDirectAutomationApply } from '../services/task/automation-legacy-direct-apply.js';
import { classifyAutomationPatch } from '../services/task/automation-patch-policy.js';
import { automationYamlDraft, evaluateAutomationConditionV1, materializeAutomationYamlV1, suggestAutomationYamlEditV1, validateAutomationYamlV1 } from '../../shared/automation-yaml.js';

router.post('/automations/validate-yaml', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });
    const yaml = typeof req.body?.yaml === 'string' ? req.body.yaml : '';
    if (!yaml.trim()) return res.status(400).json({ error: 'yaml required' });
    res.json(validateAutomationYamlV1(yaml));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get('/automations/:id/change-intents/diagnostics', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });
    const { getAutomationChangeIntentDiagnostics } = await import('../services/task/automation-change-intent.js');
    res.json(await getAutomationChangeIntentDiagnostics({
      automationId: req.params.id as string,
      actorUserId: userId,
      actorRole: role,
    }));
  } catch (err: any) { res.status(400).json({ error: err.message }); }
});

router.post('/automations/:id/change-intents/:intentId/reconcile', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });
    if (req.body?.confirmed !== true) return res.status(400).json({ error: 'reconciliation requires explicit confirmation' });
    const { reconcileAutomationChangeIntent } = await import('../services/task/automation-change-intent.js');
    res.json(await reconcileAutomationChangeIntent({
      intentId: req.params.intentId as string,
      automationId: req.params.id as string,
      actorUserId: userId,
      actorRole: role,
    }));
  } catch (err: any) { res.status(400).json({ error: err.message }); }
});

router.post('/automations/:id/change-intents', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id as string;
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });
    const automation = await getAutomation(id);
    if (!automation) return res.status(404).json({ error: 'not found' });
    const yaml = typeof req.body?.yaml === 'string' ? req.body.yaml : '';
    if (!yaml.trim()) return res.status(400).json({ error: 'yaml required' });
    const { createAutomationChangeIntent } = await import('../services/task/automation-change-intent.js');
    const intent = await createAutomationChangeIntent({
      automation,
      actorUserId: userId,
      actorRole: role,
      sourceSessionId: typeof req.body?.sourceSessionId === 'string' ? req.body.sourceSessionId : null,
      yaml,
      summary: typeof req.body?.summary === 'string' ? req.body.summary : null,
    });
    res.json(intent);
  } catch (err: any) { res.status(400).json({ error: err.message }); }
});

router.post('/automations/:id/change-intents/:intentId/apply', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });
    const proposalHash = typeof req.body?.proposalHash === 'string' ? req.body.proposalHash : '';
    if (!proposalHash) return res.status(400).json({ error: 'proposalHash required' });
    const { applyAutomationChangeIntent } = await import('../services/task/automation-change-intent.js');
    res.json(await applyAutomationChangeIntent({
      intentId: req.params.intentId as string,
      automationId: req.params.id as string,
      actorUserId: userId,
      actorRole: role,
      proposalHash,
      confirmedHighRisk: req.body?.confirmedHighRisk === true,
    }));
  } catch (err: any) { res.status(400).json({ error: err.message }); }
});

router.post('/automations/:id/editor-thread', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id as string;
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    const automation = await getAutomation(id);
    if (!automation) return res.status(404).json({ error: 'not found' });
    const access = await canAccessAutomationJob(automation, userId, role, 'propose');
    if (!access.allowed) return res.status(access.status || 403).json({ error: access.message || 'forbidden' });

    const bootstrapContent = [{ type: 'text', text: `이 자동화의 AI thread입니다.\n\n대상: ${automation.name}\n\n제가 도울 수 있는 일:\n- 이 자동화가 언제 실행되고 무엇을 하는지 쉽게 설명\n- 정상/실패/경고 상황에서 언제 조용히 넘어가고 언제 알려줄지 정리\n- AI가 개입해야 하는 조건과 보고 위치 점검\n- 변경안을 먼저 요약하고, 승인 후 반영\n\n예: “정상일 때는 조용히 넘어가고, 3번 연속 실패하면 알려줘”처럼 말해 주세요.` }];

    if (automation.sessionId) {
      const existing = await getSession(automation.sessionId);
      if (existing) {
        const existingMessages = await getMessages(existing.id);
        const hasVisibleMessage = existingMessages.some((message) => {
          const metadata = message.metadata || {};
          return metadata.hidden !== 'system-trigger' && metadata.hidden !== 'server-resume';
        });
        if (!hasVisibleMessage) {
          await saveMessage(existing.id, {
            id: uuidv4(),
            role: 'assistant',
            content: bootstrapContent,
            metadata: { automationId: automation.id, kind: 'automation-editor-bootstrap' },
          });
          await updateSession(existing.id, { turnCount: Math.max(1, existing.turnCount || 0) });
        }
        return res.json({ session: existing, created: false });
      }
    }

    const project = automation.projectId ? await getProject(automation.projectId) : null;
    const cwd = automation.cwd || project?.rootPath || config.defaultCwd;
    const parentSessionId = typeof req.body?.parentSessionId === 'string' ? req.body.parentSessionId : null;
    const session = await createSession(`Automation AI · ${automation.name}`, cwd, userId, automation.projectId, undefined, null, null, parentSessionId, 'automation-editor', null);
    await saveMessage(session.id, {
      id: uuidv4(),
      role: 'assistant',
      content: bootstrapContent,
      metadata: { automationId: automation.id, kind: 'automation-editor-bootstrap' },
    });
    await updateSession(session.id, { turnCount: 1 });
    session.turnCount = 1;
    const updated = await updateAutomation(id, { sessionId: session.id, updatedByUserId: userId });
    res.json({ session, automation: updated, created: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/automations/:id/editor-thread-message', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id as string;
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    const automation = await getAutomation(id);
    if (!automation) return res.status(404).json({ error: 'not found' });
    const access = await canAccessAutomationJob(automation, userId, role, 'propose');
    if (!access.allowed) return res.status(access.status || 403).json({ error: access.message || 'forbidden' });

    let sessionId = automation.sessionId;
    let session = sessionId ? await getSession(sessionId) : null;
    if (!session) {
      const project = automation.projectId ? await getProject(automation.projectId) : null;
      const cwd = automation.cwd || project?.rootPath || config.defaultCwd;
      const parentSessionId = typeof req.body?.parentSessionId === 'string' ? req.body.parentSessionId : null;
      session = await createSession(`Automation AI · ${automation.name}`, cwd, userId, automation.projectId, undefined, null, null, parentSessionId, 'automation-editor', null);
      sessionId = session.id;
      await updateAutomation(id, { sessionId, updatedByUserId: userId });
    }

    const yaml = typeof req.body?.yaml === 'string' && req.body.yaml.trim() ? req.body.yaml : automationYamlDraft(automation);
    const instruction = typeof req.body?.instruction === 'string' ? req.body.instruction : '';
    if (!instruction.trim()) return res.status(400).json({ error: 'instruction required' });

    await saveMessage(session.id, { id: uuidv4(), role: 'user', content: [{ type: 'text', text: instruction }], metadata: { automationId: id, kind: 'automation-editor-request' } });

    const fallback = suggestAutomationYamlEditV1(yaml, instruction);
    const raw = await runUtilityTextTask({
      prompt: `Current automation YAML:\n---\n${yaml}\n---\nUser request:\n${instruction}\n\nReturn revised YAML and a short Korean summary as strict JSON only.`,
      systemPrompt: 'You are an automation-scoped YAML editor for Tower. Return ONLY compact JSON: {"yaml":"...","summary":"..."}. Preserve unknown fields and required sections: version, trigger, run, condition, ai, report. Never add secrets. Use Korean for summary.',
      model: getModelDefaults().session,
      fallbackText: JSON.stringify({ yaml: fallback.yaml, summary: fallback.summary }),
      timeoutMs: 20_000,
    });
    let result = { ...fallback, source: 'fallback' as 'llm' | 'fallback' };
    try {
      const parsed = JSON.parse(raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim());
      const proposedYaml = typeof parsed.yaml === 'string' ? parsed.yaml : fallback.yaml;
      if (validateAutomationYamlV1(proposedYaml).ok) {
        result = { yaml: proposedYaml, summary: typeof parsed.summary === 'string' ? parsed.summary : '요청에 맞춰 YAML 변경안을 만들었습니다.', changed: proposedYaml !== yaml, source: 'llm' };
      }
    } catch {}

    await saveMessage(session.id, {
      id: uuidv4(),
      role: 'assistant',
      content: [{ type: 'text', text: `${result.summary}\n\n\`\`\`yaml\n${result.yaml}\n\`\`\`` }],
      metadata: { automationId: id, kind: 'automation-editor-suggestion', source: result.source },
    });
    res.json({ ...result, session });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/automations/:id/suggest-yaml-edit', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id as string;
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    const automation = await getAutomation(id);
    if (!automation) return res.status(404).json({ error: 'not found' });
    const access = await canAccessAutomationJob(automation, userId, role, 'propose');
    if (!access.allowed) return res.status(access.status || 403).json({ error: access.message || 'forbidden' });

    const yaml = typeof req.body?.yaml === 'string' && req.body.yaml.trim()
      ? req.body.yaml
      : automationYamlDraft(automation);
    const instruction = typeof req.body?.instruction === 'string' ? req.body.instruction : '';
    if (!instruction.trim()) return res.status(400).json({ error: 'instruction required' });

    const fallback = suggestAutomationYamlEditV1(yaml, instruction);
    const systemPrompt = `You edit Tower automation YAML v1. Return ONLY compact JSON: {"yaml":"...","summary":"..."}. Do not use markdown. Preserve unknown fields. The YAML must keep version: 1 and the sections trigger, run, condition, ai, report. Never add secrets. Use Korean for summary.`;
    const prompt = `Current automation YAML:\n---\n${yaml}\n---\nUser request in Korean or English:\n${instruction}\n\nReturn revised YAML and a short Korean summary.`;
    const raw = await runUtilityTextTask({
      prompt,
      systemPrompt,
      model: getModelDefaults().session,
      fallbackText: JSON.stringify({ yaml: fallback.yaml, summary: fallback.summary }),
      timeoutMs: 20_000,
    });
    try {
      const parsed = JSON.parse(raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim());
      const proposedYaml = typeof parsed.yaml === 'string' ? parsed.yaml : fallback.yaml;
      const validation = validateAutomationYamlV1(proposedYaml);
      if (!validation.ok) return res.json({ ...fallback, summary: `${fallback.summary} (LLM 제안은 검증에 실패해 안전한 기본 제안을 사용했습니다.)` });
      res.json({ yaml: proposedYaml, summary: typeof parsed.summary === 'string' ? parsed.summary : '요청에 맞춰 YAML 변경안을 만들었습니다.', changed: proposedYaml !== yaml });
    } catch {
      res.json({ ...fallback, summary: `${fallback.summary} (LLM 응답을 해석하지 못해 안전한 기본 제안을 사용했습니다.)` });
    }
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/automations/:id/apply-yaml', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id as string;
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    const automation = await getAutomation(id);
    if (!automation) return res.status(404).json({ error: 'not found' });
    const legacyAuthorization = authorizeLegacyDirectAutomationApply({
      role,
      confirmed: req.body?.confirmedLegacyDirectApply === true,
      reason: req.body?.reason,
    });
    if (!legacyAuthorization.allowed) return res.status(legacyAuthorization.status || 403).json({
      error: legacyAuthorization.message || 'forbidden',
      deprecated: true,
      replacement: `/api/automations/${id}/change-intents`,
    });
    const access = await canAccessAutomationJob(automation, userId, role, 'edit');
    if (!access.allowed) return res.status(access.status || 403).json({ error: access.message || 'forbidden' });

    const yaml = typeof req.body?.yaml === 'string' ? req.body.yaml : '';
    if (!yaml.trim()) return res.status(400).json({ error: 'yaml required' });
    const validation = validateAutomationYamlV1(yaml);
    if (!validation.ok) return res.status(400).json({ error: 'invalid automation yaml', validation });

    const materialized = materializeAutomationYamlV1(yaml);
    const mutationPolicy = await authorizeAutomationMutation({
      actor: { userId, role },
      existing: automation,
      mutation: {
        projectId: automation.projectId,
        jobType: materialized.updates.jobType,
        scopeType: automation.scopeType,
        definitionJson: materialized.updates.definitionJson,
        confirmedHighRisk: req.body?.confirmedHighRisk === true,
      },
    });
    if (!mutationPolicy.allowed) return res.status(mutationPolicy.status || 403).json({ error: mutationPolicy.message || 'forbidden' });
    const updated = await applyLegacyAutomationConfig({
      automationId: id,
      actorUserId: userId,
      expectedConfigUpdatedAt: automation.configUpdatedAt,
      updates: { ...materialized.updates as any, riskLevel: mutationPolicy.riskLevel },
      reason: legacyAuthorization.reason!,
    });

    let sourcePath: string | null = null;
    let historyPath: string | null = null;
    let metaPath: string | null = null;
    if (automation.projectId) {
      const project = await getProject(automation.projectId);
      if (project?.rootPath) {
        const slug = String(req.body?.slug || materialized.updates.name || automation.name)
          .toLowerCase()
          .replace(/[^a-z0-9가-힣]+/gi, '-')
          .replace(/^-|-$/g, '') || 'automation';
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const relativePath = path.posix.join('automations', `${slug}.yaml`);
        sourcePath = path.resolve(project.rootPath, relativePath);
        const root = path.resolve(project.rootPath);
        if (!(sourcePath === root || sourcePath.startsWith(root + path.sep))) return res.status(400).json({ error: 'path escapes project' });
        const historyDir = path.join(project.rootPath, 'automations', '.history', slug);
        historyPath = path.join(historyDir, `${stamp}.yaml`);
        metaPath = path.join(historyDir, `${stamp}.meta.json`);
        await fsPromises.mkdir(path.dirname(sourcePath), { recursive: true });
        await fsPromises.mkdir(historyDir, { recursive: true });
        await fsPromises.writeFile(sourcePath, yaml, 'utf-8');
        await fsPromises.writeFile(historyPath, yaml, 'utf-8');
        await fsPromises.writeFile(metaPath, JSON.stringify({
          automationId: id,
          appliedAt: new Date().toISOString(),
          userId,
          source: req.body?.source || 'workbench',
          reason: typeof req.body?.reason === 'string' ? req.body.reason : null,
          editorSessionId: automation.sessionId || null,
          warnings: materialized.warnings,
          updatedFields: Object.keys(materialized.updates),
        }, null, 2), 'utf-8');
      }
    }

    res.setHeader('Deprecation', 'true');
    res.setHeader('Link', `</api/automations/${id}/change-intents>; rel="successor-version"`);
    res.json({ ok: true, deprecated: true, replacement: `/api/automations/${id}/change-intents`, automation: updated, validation, warnings: materialized.warnings, sourcePath, historyPath, metaPath });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/automations/:id/full-dry-run', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id as string;
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    const automation = await getAutomation(id);
    if (!automation) return res.status(404).json({ error: 'not found' });
    const access = await canAccessAutomationJob(automation, userId, role, 'run');
    if (!access.allowed) return res.status(access.status || 403).json({ error: access.message || 'forbidden' });

    const yaml = typeof req.body?.yaml === 'string' && req.body.yaml.trim()
      ? req.body.yaml
      : automationYamlDraft(automation);
    const { runAutomationObserveOnly } = await import('../services/task/automation-runners.js');
    const observe = await runAutomationObserveOnly(automation);
    const condition = evaluateAutomationConditionV1(yaml, observe.stdoutText || null);
    res.json({ observe, condition, wouldCallAi: condition.aiNeeded, wouldReport: condition.aiNeeded });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/automations/:id/condition-dry-run', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id as string;
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    const automation = await getAutomation(id);
    if (!automation) return res.status(404).json({ error: 'not found' });
    const access = await canAccessAutomationJob(automation, userId, role, 'read');
    if (!access.allowed) return res.status(access.status || 403).json({ error: access.message || 'forbidden' });

    const yaml = typeof req.body?.yaml === 'string' && req.body.yaml.trim()
      ? req.body.yaml
      : automationYamlDraft(automation);
    const stdoutText = typeof req.body?.stdoutText === 'string'
      ? req.body.stdoutText
      : typeof req.body?.stdout === 'string'
        ? req.body.stdout
        : null;
    res.json(evaluateAutomationConditionV1(yaml, stdoutText));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/automations/:id/observe-dry-run', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id as string;
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    const automation = await getAutomation(id);
    if (!automation) return res.status(404).json({ error: 'not found' });
    const access = await canAccessAutomationJob(automation, userId, role, 'run');
    if (!access.allowed) return res.status(access.status || 403).json({ error: access.message || 'forbidden' });

    const { runAutomationObserveOnly } = await import('../services/task/automation-runners.js');
    const result = await runAutomationObserveOnly(automation);
    res.json(result);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/automations/:id/save-yaml', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id as string;
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    const automation = await getAutomation(id);
    if (!automation) return res.status(404).json({ error: 'not found' });
    const access = await canAccessAutomationJob(automation, userId, role, 'edit');
    if (!access.allowed) return res.status(access.status || 403).json({ error: access.message || 'forbidden' });
    if (!automation.projectId) return res.status(400).json({ error: 'YAML source of truth requires a project automation' });

    const project = await getProject(automation.projectId);
    if (!project?.rootPath) return res.status(404).json({ error: 'project not found' });

    const yaml = typeof req.body?.yaml === 'string' ? req.body.yaml : '';
    if (!yaml.trim()) return res.status(400).json({ error: 'yaml required' });
    const validation = validateAutomationYamlV1(yaml);
    if (!validation.ok) return res.status(400).json({ error: 'invalid automation yaml', validation });

    const slug = String(req.body?.slug || automation.name)
      .toLowerCase()
      .replace(/[^a-z0-9가-힣]+/gi, '-')
      .replace(/^-|-$/g, '') || 'automation';
    const relativePath = path.posix.join('automations', `${slug}.yaml`);
    const filePath = path.resolve(project.rootPath, relativePath);
    const root = path.resolve(project.rootPath);
    if (!(filePath === root || filePath.startsWith(root + path.sep))) return res.status(400).json({ error: 'path escapes project' });

    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const historyDir = path.join(project.rootPath, 'automations', '.history', slug);
    await fsPromises.mkdir(historyDir, { recursive: true });
    await fsPromises.writeFile(path.join(historyDir, `${stamp}.yaml`), yaml, 'utf-8');
    await fsPromises.writeFile(filePath, yaml, 'utf-8');
    res.json({ ok: true, path: filePath, relativePath, historyPath: path.join(historyDir, `${stamp}.yaml`), validation });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// List automations (with filters)
router.get('/automations', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    const filters: AutomationFilters = {};
    if (req.query.status) {
      const s = req.query.status as string;
      filters.status = s.includes(',') ? s.split(',') as any : s as any;
    }
    if (req.query.trigger) filters.triggerType = req.query.trigger as any;
    if (req.query.project) filters.projectId = req.query.project as string;
    if (req.query.mode) filters.mode = req.query.mode as any;
    if (req.query.includeArchived === 'true') filters.includeArchived = true;

    const automations = await getAutomations(userId, role, filters);
    res.json(automations);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// CWD metadata
router.get('/automations/meta', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const cwds = await getAutomationCwds(userId);
    res.json({ cwds });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Templates
router.get('/automations/templates', authMiddleware, async (_req, res) => {
  try {
    res.json(getTemplates());
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Read-only migration/registry audit (admin/operator)
router.get('/automations/audit/state', authMiddleware, async (req, res) => {
  try {
    const role = (req as any).user?.role;
    if (role !== 'admin' && role !== 'operator') return res.status(403).json({ error: 'forbidden' });
    const { auditScheduleState } = await import('../services/task/schedule-audit.js');
    res.json(await auditScheduleState());
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Read-only dry-run: legacy tasks.scheduled_at/schedule_cron → automations plan.
router.get('/automations/audit/legacy-task-migration', authMiddleware, async (req, res) => {
  try {
    const role = (req as any).user?.role;
    if (role !== 'admin' && role !== 'operator') return res.status(403).json({ error: 'forbidden' });
    const { planLegacyTaskScheduleMigration } = await import('../services/task/legacy-task-migration.js');
    res.json(await planLegacyTaskScheduleMigration());
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Archived must be registered before /automations/:id
router.get('/automations/archived', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const archived = await getArchivedAutomations(userId);
    res.json(archived);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Create from template
router.post('/automations/from-template', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });
    const { templateId, confirmedHighRisk, ...overrides } = req.body;
    if (!templateId) return res.status(400).json({ error: 'templateId required' });

    const template = getTemplates().find((item) => item.id === templateId);
    if (!template) return res.status(404).json({ error: 'template not found' });
    const projectId = typeof overrides.projectId === 'string' ? overrides.projectId : null;
    const mutationPolicy = await authorizeAutomationMutation({
      actor: { userId, role },
      mutation: {
        projectId,
        jobType: 'ai_prompt',
        scopeType: projectId ? 'project' : 'system',
        definitionJson: { prompt: overrides.prompt || template.promptTemplate },
        confirmedHighRisk: confirmedHighRisk === true,
      },
    });
    if (!mutationPolicy.allowed) return res.status(mutationPolicy.status || 403).json({ error: mutationPolicy.message || 'forbidden' });

    const automation = await createFromTemplate(templateId, userId, overrides);
    res.json(automation);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Get one
router.get('/automations/:id', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id as string;
    const automation = await getAutomation(id);
    if (!automation) return res.status(404).json({ error: 'not found' });
    const access = await canAccessAutomationJob(automation, (req as any).user?.userId, (req as any).user?.role);
    if (!access.allowed) return res.status(access.status || 403).json({ error: access.message || 'forbidden' });
    res.json(automation);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Create
router.post('/automations', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    const { name, prompt, description, model, workflow, mode, targetId, cwd,
            jobType, scopeType, definitionJson, timeoutSeconds, timezone, createdBySessionId,
            confirmedHighRisk,
            triggerType, cronConfig, onceAt, parentId, projectId,
            roomId, triggeredBy, roomMessageId } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const role = (req as any).user?.role;
    if (roomId) {
      const roomAccess = await canAccessRoom(roomId, userId, role);
      if (!roomAccess.allowed) return res.status(roomAccess.status).json({ error: roomAccess.message });
    }

    const effectiveDefinition = definitionJson || {};
    const effectiveJobType = jobType || 'ai_prompt';
    const effectiveScopeType = scopeType || (projectId ? 'project' : 'system');
    const mutationPolicy = await authorizeAutomationMutation({
      actor: { userId, role },
      mutation: {
        projectId,
        jobType: effectiveJobType,
        scopeType: effectiveScopeType,
        definitionJson: effectiveDefinition,
        confirmedHighRisk: confirmedHighRisk === true,
      },
    });
    if (!mutationPolicy.allowed) return res.status(mutationPolicy.status || 403).json({ error: mutationPolicy.message || 'forbidden' });
    const effectiveRiskLevel = mutationPolicy.riskLevel;

    const automation = await createAutomation({
      userId, projectId, name, description, prompt: prompt || '',
      model, workflow, jobType: effectiveJobType, scopeType: effectiveScopeType, definitionJson: effectiveDefinition, riskLevel: effectiveRiskLevel, timeoutSeconds, timezone, createdBySessionId,
      mode, targetId, cwd,
      triggerType, cronConfig, onceAt, parentId,
      roomId, triggeredBy, roomMessageId,
    });
    res.json(automation);
  } catch (err: any) {
    if (err?.code === 'INTERNAL_CHANNEL_RETIRED') return res.status(410).json({ error: err.message, code: err.code });
    res.status(500).json({ error: err.message });
  }
});

router.post('/automations/:id/enabled', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id as string;
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'enabled boolean required' });
    if (req.body?.confirmed !== true) return res.status(400).json({ error: 'enable/disable change requires explicit confirmation' });
    const existing = await getAutomation(id);
    if (!existing) return res.status(404).json({ error: 'not found' });
    const access = await canAccessAutomationJob(existing, userId, role, 'edit');
    if (!access.allowed) return res.status(access.status || 403).json({ error: access.message || 'forbidden' });
    const { setAutomationEnabled } = await import('../services/task/automation-control.js');
    res.json(await setAutomationEnabled(existing, req.body.enabled, userId));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Compatibility PATCH: config edits are rejected; enabled-only callers are deprecated.
router.patch('/automations/:id', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id as string;
    const existing = await getAutomation(id);
    if (!existing) return res.status(404).json({ error: 'not found' });

    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    const access = await canAccessAutomationJob(existing, userId, role, 'edit');
    if (!access.allowed) return res.status(access.status || 403).json({ error: access.message || 'forbidden' });
    const patch = classifyAutomationPatch(req.body);
    if (!patch.allowed) {
      return res.status(409).json({
        error: patch.configFields.length
          ? 'automation config changes require a reviewed change intent'
          : 'PATCH accepts only the enabled boolean control field',
        configFields: patch.configFields,
        unknownFields: patch.unknownFields,
        replacement: patch.configFields.length ? `/api/automations/${id}/change-intents` : `/api/automations/${id}/enabled`,
      });
    }
    const { setAutomationEnabled } = await import('../services/task/automation-control.js');
    const automation = await setAutomationEnabled(existing, patch.controlUpdates.enabled as boolean, userId);
    res.setHeader('Deprecation', 'true');
    res.setHeader('Link', `</api/automations/${id}/enabled>; rel="successor-version"`);
    res.json(automation);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Delete (soft)
router.delete('/automations/:id', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id as string;
    const existing = await getAutomation(id);
    if (!existing) return res.status(404).json({ error: 'not found' });

    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    const access = await canAccessAutomationJob(existing, userId, role, 'archive');
    if (!access.allowed) return res.status(access.status || 403).json({ error: access.message || 'forbidden' });

    await deleteAutomation(id);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Permanently delete
router.delete('/automations/:id/permanent', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id as string;
    const role = (req as any).user?.role;
    if (!isScheduleOperator(role)) return res.status(403).json({ error: 'forbidden' });
    await permanentlyDeleteAutomation(id);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Restore from archive
router.post('/automations/:id/restore', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id as string;
    const existing = await getAutomation(id);
    if (!existing) return res.status(404).json({ error: 'not found' });
    const access = await canAccessAutomationJob(existing, (req as any).user?.userId, (req as any).user?.role, 'archive');
    if (!access.allowed) return res.status(access.status || 403).json({ error: access.message || 'forbidden' });
    const ok = await restoreAutomation(id);
    res.json({ success: ok });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Run now (manual trigger; does not advance cron next_run_at)
router.post('/automations/:id/run-now', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id as string;
    const automation = await getAutomation(id);
    if (!automation) return res.status(404).json({ error: 'not found' });

    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    const access = await canAccessAutomationJob(automation, userId, role, 'run');
    if (!access.allowed) return res.status(access.status || 403).json({ error: access.message || 'forbidden' });

    const { runAutomationNow } = await import('../services/task/automation-control.js');
    const result = await runAutomationNow({
      automation,
      broadcast: (type, payload) => broadcast({ type, ...payload }),
    });
    res.json(result);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Child automations
router.get('/automations/:id/children', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id as string;
    const automation = await getAutomation(id);
    if (!automation) return res.status(404).json({ error: 'not found' });
    const access = await canAccessAutomationJob(automation, (req as any).user?.userId, (req as any).user?.role);
    if (!access.allowed) return res.status(access.status || 403).json({ error: access.message || 'forbidden' });
    const children = await getChildAutomations(id);
    res.json(children);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Run process map
router.get('/automations/:id/runs/:runId/process-map', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id as string;
    const runId = req.params.runId as string;
    const automation = await getAutomation(id);
    if (!automation) return res.status(404).json({ error: 'not found' });
    const access = await canAccessAutomationJob(automation, (req as any).user?.userId, (req as any).user?.role);
    if (!access.allowed) return res.status(access.status || 403).json({ error: access.message || 'forbidden' });
    const runs = await getAutomationRuns(id, 100);
    const run = runs.find((r) => r.id === runId);
    if (!run) return res.status(404).json({ error: 'run not found' });
    res.json(await getAutomationRunProcessMap(automation, run));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Run history
router.get('/automations/:id/runs', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id as string;
    const automation = await getAutomation(id);
    if (!automation) return res.status(404).json({ error: 'not found' });
    const access = await canAccessAutomationJob(automation, (req as any).user?.userId, (req as any).user?.role);
    if (!access.allowed) return res.status(access.status || 403).json({ error: access.message || 'forbidden' });
    const limit = parseInt(req.query.limit as string) || 20;
    const runs = await getAutomationRuns(id, Math.min(limit, 100));
    res.json(runs);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Reorder (kanban drag-drop)
router.post('/automations/reorder', authMiddleware, async (req, res) => {
  try {
    const { taskIds, status } = req.body;
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });
    if (!Array.isArray(taskIds) || !status) {
      return res.status(400).json({ error: 'taskIds array and status required' });
    }
    for (const id of taskIds) {
      const automation = await getAutomation(String(id));
      if (!automation) return res.status(404).json({ error: `automation not found: ${id}` });
      const access = await canAccessAutomationJob(automation, userId, role, 'edit');
      if (!access.allowed) return res.status(access.status || 403).json({ error: access.message || 'forbidden' });
    }
    await reorderAutomations(taskIds.map(String), status);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════
// Proactive Agent — AI가 먼저 말을 거는 시스템
// ═══════════════════════════════════════════════════════════════

router.post('/proactive/fire', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const userRole = (req as any).user?.role;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });
    if (userRole !== 'admin') return res.status(403).json({ error: 'admin only (phase 1)' });

    const { templateName, prompt, context, projectId, model, targetSessionId } = req.body;
    if (!templateName || !prompt) {
      return res.status(400).json({ error: 'templateName and prompt are required' });
    }

    const { fireProactive } = await import('../services/ai/proactive-agent.js');

    const template = {
      id: `manual-${Date.now()}`,
      name: templateName,
      prompt,
      model: model || undefined,
      projectId: projectId || undefined,
    };

    const result = await fireProactive(
      userId,
      template,
      context ? { summary: context } : undefined,
      targetSessionId ? { targetSessionId } : undefined,
    );

    res.json(result);
  } catch (err: any) {
    console.error('[proactive] Fire error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ───── Fleet Management (admin/operator/customer_manager scoped) ─────
import {
  getCustomers, getCustomer, getFleetStatus, getVMStatus,
  checkWorkspace, getLogs, remoteExec,
} from '../services/deploy/fleet-manager.js';

function fleetAccessMiddleware(req: any, res: any, next: any) {
  const user = req.user;
  if (!user || !['admin', 'operator', 'customer_manager'].includes(user.role)) {
    return res.status(403).json({ error: 'Fleet access required' });
  }
  next();
}

async function requireFleetCustomerAccess(req: any, res: any, customerName: string): Promise<boolean> {
  const user = req.user;
  const ok = await userCanAccessCustomerName(user?.userId, user?.role, customerName);
  if (!ok) {
    res.status(403).json({ error: `No access to self-hosted server: ${customerName}` });
    return false;
  }
  return true;
}

// List customers visible to the current fleet role.
router.get('/admin/fleet', fleetAccessMiddleware, async (req, res) => {
  try {
    const customers = await getCustomers();
    const allowed = await listAccessibleCustomerNames((req as any).user?.userId, (req as any).user?.role);
    res.json(allowed === null ? customers : customers.filter(c => allowed.includes(c.name)));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Fleet status. admin/operator see all, customer_manager sees mapped VMs only.
router.get('/admin/fleet/status', fleetAccessMiddleware, async (req, res) => {
  try {
    const allowed = await listAccessibleCustomerNames((req as any).user?.userId, (req as any).user?.role);
    if (allowed === null) {
      const status = await getFleetStatus();
      return res.json(status);
    }
    const customers = (await getCustomers()).filter(c => allowed.includes(c.name));
    const status = await Promise.all(customers.map(c => getVMStatus(c)));
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Single customer status
router.get('/admin/fleet/:customer/status', fleetAccessMiddleware, async (req, res) => {
  try {
    const info = await getCustomer(req.params.customer as string);
    if (!info) return res.status(404).json({ error: 'Customer not found' });
    if (!(await requireFleetCustomerAccess(req, res, info.name))) return;
    const status = await getVMStatus(info);
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Workspace health check
router.get('/admin/fleet/:customer/workspace', fleetAccessMiddleware, async (req, res) => {
  try {
    const info = await getCustomer(req.params.customer as string);
    if (!info) return res.status(404).json({ error: 'Customer not found' });
    if (!(await requireFleetCustomerAccess(req, res, info.name))) return;
    const check = await checkWorkspace(info);
    res.json(check);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Logs
router.get('/admin/fleet/:customer/logs', fleetAccessMiddleware, async (req, res) => {
  try {
    const info = await getCustomer(req.params.customer as string);
    if (!info) return res.status(404).json({ error: 'Customer not found' });
    if (!(await requireFleetCustomerAccess(req, res, info.name))) return;
    const lines = parseInt(req.query.lines as string) || 30;
    const logs = await getLogs(info, Math.min(lines, 200));
    res.json({ logs });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Remote command execution
// SECURITY (TWR-03, 2026-04-28): disabled by default. Substring blocklist in
// remoteExec is trivially bypassable, and an admin JWT here yields instant
// self-hosted-server takeover. Re-enable temporarily via FLEET_EXEC_ENABLED only for
// emergency ops; prefer direct SSH for routine work. A command-catalog
// redesign is the medium-term replacement.
router.post('/admin/fleet/:customer/exec', fleetAccessMiddleware, async (req, res) => {
  if (!config.fleetExecEnabled) {
    return res.status(503).json({
      error: 'Remote exec disabled. Set FLEET_EXEC_ENABLED=true to enable temporarily. Pending command-catalog redesign (TWR-03).'
    });
  }
  try {
    const info = await getCustomer(req.params.customer as string);
    if (!info) return res.status(404).json({ error: 'Customer not found' });
    if (!(await requireFleetCustomerAccess(req, res, info.name))) return;
    const { command } = req.body;
    if (!command) return res.status(400).json({ error: 'command required' });
    const output = await remoteExec(info, command);
    res.json({ output });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// AI-native PM / Ideas alpha routes were retired.
// See workspace/decisions/2026-06-09-pm-ideas-removal-and-session-memory-cards.md

// ───── Sandbox — Phase 1c scratch file download ─────
//
// 결정: workspace/decisions/2026-04-28-execution-sandbox-q2-result-surface.md
// 인증: 본인의 run 만 다운로드 (admin 은 전체).
// 경로: workspace/<username>/.sandbox/runs/<run_id>/<file_name>
// download_url 패턴은 sandbox.ts 의 scratch_files 메타에서 생성 (Phase 1c).
router.get('/sandbox/runs/:runId/files/*', async (req, res) => {
  try {
    const userId = Number((req as any).user?.userId);
    const userRole = String((req as any).user?.role ?? 'member');
    if (!userId) return res.status(401).json({ error: 'Auth required' });

    const runId = parseInt(req.params.runId, 10);
    if (!Number.isInteger(runId) || runId <= 0) {
      return res.status(400).json({ error: 'invalid run_id' });
    }

    const { getPgPool, isPgEnabled } = await import('../db/pg.js');
    if (!isPgEnabled()) return res.status(503).json({ error: 'database unavailable' });

    const { rows } = await getPgPool().query<{
      user_id: number;
      username: string;
      scratch_files: Array<{ name: string; size: number; mime: string }>;
    }>(
      `SELECT r.user_id, u.username, r.scratch_files
         FROM sandbox_runs r
         JOIN users u ON u.id = r.user_id
        WHERE r.id = $1`,
      [runId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'run not found' });
    const row = rows[0];

    // owner 본인 또는 admin
    if (row.user_id !== userId && userRole !== 'admin') {
      return res.status(403).json({ error: 'not your run' });
    }

    // Express wildcard `*` 의 매칭 결과는 req.params[0]
    const fileName = String((req.params as any)[0] ?? '');
    if (!fileName) return res.status(400).json({ error: 'fileName required' });
    const meta = row.scratch_files.find((f) => f.name === fileName);
    if (!meta) return res.status(404).json({ error: 'file not in scratch_files' });

    const pathLib = await import('path');
    const fs = await import('fs');
    const { config } = await import('../config.js');
    const expectedRoot = pathLib.resolve(
      config.workspaceRoot,
      row.username,
      '.sandbox',
      'runs',
      String(runId),
    );
    const fullPath = pathLib.resolve(expectedRoot, fileName);
    if (!fullPath.startsWith(expectedRoot + pathLib.sep)) {
      return res.status(400).json({ error: 'invalid file path' });
    }
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'file not found on disk' });
    }

    res.setHeader('Content-Type', meta.mime || 'application/octet-stream');
    res.setHeader('Content-Length', String(meta.size));
    const inlineOk = /^(image\/|text\/|application\/json)/.test(meta.mime ?? '');
    res.setHeader(
      'Content-Disposition',
      contentDispositionHeader(inlineOk ? 'inline' : 'attachment', fileName),
    );
    fs.createReadStream(fullPath).pipe(res);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
