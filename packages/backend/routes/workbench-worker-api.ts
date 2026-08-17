/**
 * Owns: authenticated Worker registration/heartbeat and operator Worker lifecycle API.
 * Public API: Express router mounted at /api/workbench-workers.
 * See: packages/backend/services/runtime-box/README.md.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { adminMiddleware, authMiddleware } from '../services/auth/auth.js';
import {
  heartbeatPersistedWorkbenchWorker,
  listPersistedWorkbenchWorkers,
  setPersistedWorkbenchWorkerDrain,
  upsertWorkbenchWorker,
} from '../services/runtime-box/workbench-worker-repository.js';
import { issueWorkbenchWorkerIdentity, verifyWorkbenchWorkerIdentity, type WorkbenchWorkerIdentity } from '../services/runtime-box/workbench-worker-identity.js';
import {
  configureWorkbenchWorkerTransportCredential,
  getWorkbenchWorkerTransportCredentialBinding,
  removeWorkbenchWorkerTransportCredentialBinding,
} from '../services/runtime-box/workbench-worker-transport-credentials.js';
import { applyProjectWorkerEmergencyFallback, previewProjectWorkerEmergencyFallback } from '../services/runtime-box/workbench-project-emergency-fallback.js';
import {
  assertWorkbenchWorkerIdentityActive,
  getWorkbenchWorkerIdentity,
  listWorkbenchWorkerIdentities,
  recordWorkbenchWorkerIdentity,
  revokeWorkbenchWorkerIdentity,
  rotateWorkbenchWorkerIdentity,
} from '../services/runtime-box/workbench-worker-identity-repository.js';

const router = Router();
const capacitySchema = z.object({
  cpuTotal: z.number().int().min(0).max(65_536),
  memoryMbTotal: z.number().int().min(0).max(1_073_741_824),
  activeRuns: z.number().int().min(0).max(1_000_000),
  maxRuns: z.number().int().min(1).max(1_000_000),
}).refine(value => value.activeRuns <= value.maxRuns, 'activeRuns must not exceed maxRuns');
export const registrationSchema = z.object({
  workerId: z.string().min(1).max(120),
  deploymentId: z.string().regex(/^[a-zA-Z0-9._-]{1,120}$/),
  baseUrl: z.string().url().max(2_000),
  capabilities: z.array(z.string().min(1).max(120)).min(1).max(100),
  projectIds: z.array(z.string().min(1).max(200)).min(1).max(10_000),
  capacity: capacitySchema,
}).strict();
export const heartbeatSchema = z.object({ workerId: z.string().min(1).max(120), capacity: capacitySchema }).strict();
export const drainSchema = z.object({ draining: z.boolean() }).strict();
const identityIssueSchema = z.object({
  workerId: z.string().min(1).max(120),
  projectIds: z.array(z.string().min(1).max(200)).min(1).max(10_000),
  capabilities: z.array(z.string().min(1).max(120)).min(1).max(100),
  expiresIn: z.string().regex(/^[1-9][0-9]*[mhd]$/).max(20).optional(),
  reason: z.string().max(500).optional(),
}).strict();
const identityRevokeSchema = z.object({ reason: z.string().max(500).optional() }).strict();
const identityRotateSchema = identityIssueSchema.omit({ workerId: true }).strict();
const transportCredentialSchema = z.object({ token: z.string().min(1).max(16_384) }).strict();
const emergencyFallbackPreviewSchema = z.object({
  deploymentId: z.string().regex(/^[a-zA-Z0-9._-]{1,120}$/),
  reason: z.string().min(1).max(500),
  sessionId: z.string().max(200).optional(),
}).strict();
const emergencyFallbackApplySchema = z.object({
  deploymentId: z.string().regex(/^[a-zA-Z0-9._-]{1,120}$/),
  intentId: z.string().uuid(),
  proposalHash: z.string().regex(/^[0-9a-f]{64}$/),
  confirmed: z.literal(true),
}).strict();

type WorkerRequest = Request & { workbenchWorker?: WorkbenchWorkerIdentity };

function sameSet(left: string[], right: string[]): boolean {
  return [...new Set(left)].sort().join('\0') === [...new Set(right)].sort().join('\0');
}

/** Enforce that registration cannot widen or impersonate its signed identity. */
export function validateWorkbenchWorkerRegistrationIdentity(
  identity: WorkbenchWorkerIdentity,
  registration: z.infer<typeof registrationSchema>,
): 'WORKER_IDENTITY_MISMATCH' | 'WORKER_PROJECT_SCOPE_MISMATCH' | 'WORKER_CAPABILITY_SCOPE_MISMATCH' | null {
  if (registration.workerId !== identity.workerId) return 'WORKER_IDENTITY_MISMATCH';
  if (!sameSet(registration.projectIds, identity.projectIds)) return 'WORKER_PROJECT_SCOPE_MISMATCH';
  if (!sameSet(registration.capabilities, identity.capabilities)) return 'WORKER_CAPABILITY_SCOPE_MISMATCH';
  return null;
}

/** Authenticate only a signed Worker JWT; browser/service tokens cannot enter this namespace. */
export async function workbenchWorkerIdentityMiddleware(req: WorkerRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  const identity = match ? verifyWorkbenchWorkerIdentity(match[1]) : null;
  if (!identity) return res.status(401).json({ error: 'Valid Workbench Worker identity required' });
  try {
    await assertWorkbenchWorkerIdentityActive(identity);
  } catch {
    return res.status(401).json({ error: 'Workbench Worker identity inactive' });
  }
  req.workbenchWorker = identity;
  next();
}

router.post('/register', workbenchWorkerIdentityMiddleware, async (req: WorkerRequest, res) => {
  const parsed = registrationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid Worker registration', issues: parsed.error.issues });
  const identityError = validateWorkbenchWorkerRegistrationIdentity(req.workbenchWorker!, parsed.data);
  if (identityError) return res.status(403).json({ error: identityError });
  try {
    res.json(await upsertWorkbenchWorker(parsed.data));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : 'Worker registration failed' });
  }
});

router.post('/heartbeat', workbenchWorkerIdentityMiddleware, async (req: WorkerRequest, res) => {
  const parsed = heartbeatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid Worker heartbeat', issues: parsed.error.issues });
  if (parsed.data.workerId !== req.workbenchWorker!.workerId) return res.status(403).json({ error: 'Worker identity mismatch' });
  try {
    res.json(await heartbeatPersistedWorkbenchWorker(parsed.data));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Worker heartbeat failed';
    res.status(message === 'WORKER_NOT_REGISTERED' ? 404 : 409).json({ error: message });
  }
});

router.get('/', authMiddleware, adminMiddleware, async (_req, res) => {
  res.json(await listPersistedWorkbenchWorkers());
});

router.post('/identities', authMiddleware, adminMiddleware, async (req: any, res) => {
  const parsed = identityIssueSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid Worker identity request', issues: parsed.error.issues });
  try {
    const issued = issueWorkbenchWorkerIdentity(parsed.data);
    await recordWorkbenchWorkerIdentity({ identity: issued.identity, issuedByUserId: req.user.userId, reason: parsed.data.reason });
    res.status(201).json({ token: issued.token, identity: issued.identity });
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : 'Worker identity issue failed' });
  }
});

router.get('/:workerId/identities', authMiddleware, adminMiddleware, async (req, res) => {
  res.json(await listWorkbenchWorkerIdentities(String(req.params.workerId), Number(req.query.limit ?? 20)));
});

router.post('/identities/:jti/revoke', authMiddleware, adminMiddleware, async (req, res) => {
  const parsed = identityRevokeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid revoke request', issues: parsed.error.issues });
  const revoked = await revokeWorkbenchWorkerIdentity({ jti: String(req.params.jti), reason: parsed.data.reason });
  if (!revoked) return res.status(404).json({ error: 'WORKER_IDENTITY_NOT_FOUND' });
  res.json({ ok: true, jti: String(req.params.jti) });
});

router.post('/identities/:jti/rotate', authMiddleware, adminMiddleware, async (req: any, res) => {
  const parsed = identityRotateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid rotate request', issues: parsed.error.issues });
  try {
    const previous = await getWorkbenchWorkerIdentity(String(req.params.jti));
    if (!previous) return res.status(404).json({ error: 'WORKER_IDENTITY_NOT_FOUND' });
    const workerId = previous.worker_id;
    const issued = issueWorkbenchWorkerIdentity({ workerId, ...parsed.data });
    await rotateWorkbenchWorkerIdentity({ previousJti: String(req.params.jti), replacement: issued.identity, issuedByUserId: req.user.userId, reason: parsed.data.reason });
    res.status(201).json({ token: issued.token, identity: issued.identity });
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : 'Worker identity rotation failed' });
  }
});

router.put('/:workerId/transport-credential', authMiddleware, adminMiddleware, async (req: any, res) => {
  const parsed = transportCredentialSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid transport credential request' });
  try {
    const binding = await configureWorkbenchWorkerTransportCredential({
      workerId: String(req.params.workerId), token: parsed.data.token, actorUserId: req.user.userId,
    });
    res.json({ workerId: binding.worker_id, configuredAt: binding.configured_at, updatedAt: binding.updated_at });
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : 'Transport credential configuration failed' });
  }
});

router.get('/:workerId/transport-credential', authMiddleware, adminMiddleware, async (req, res) => {
  const binding = await getWorkbenchWorkerTransportCredentialBinding(String(req.params.workerId));
  res.json({ configured: Boolean(binding), workerId: String(req.params.workerId), updatedAt: binding?.updated_at ?? null });
});

router.delete('/:workerId/transport-credential', authMiddleware, adminMiddleware, async (req, res) => {
  res.json({ ok: await removeWorkbenchWorkerTransportCredentialBinding(String(req.params.workerId)) });
});

router.post('/projects/:projectId/emergency-fallback/preview', authMiddleware, adminMiddleware, async (req: any, res) => {
  const parsed = emergencyFallbackPreviewSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid emergency fallback preview', issues: parsed.error.issues });
  try {
    res.json(await previewProjectWorkerEmergencyFallback({
      projectId: String(req.params.projectId), deploymentId: parsed.data.deploymentId, reason: parsed.data.reason,
      actor: { userId: req.user.userId, role: req.user.role, sessionId: parsed.data.sessionId ?? null },
    }));
  } catch (error) {
    const code = (error as any)?.code;
    res.status(code === 'WORKSTATION_BINDING_NOT_ACTIVE' ? 409 : 403).json({ error: code || 'EMERGENCY_FALLBACK_PREVIEW_FAILED', message: (error as Error).message });
  }
});

router.post('/projects/:projectId/emergency-fallback/apply', authMiddleware, adminMiddleware, async (req: any, res) => {
  const parsed = emergencyFallbackApplySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid emergency fallback apply', issues: parsed.error.issues });
  try {
    res.json(await applyProjectWorkerEmergencyFallback({
      projectId: String(req.params.projectId), deploymentId: parsed.data.deploymentId,
      intentId: parsed.data.intentId, proposalHash: parsed.data.proposalHash, confirmed: true,
      actor: { userId: req.user.userId, role: req.user.role },
    }));
  } catch (error) {
    const code = (error as any)?.code;
    res.status(['STALE_INTENT','BINDING_STATE_CHANGED','INTENT_EXPIRED_OR_CONSUMED'].includes(code) ? 409 : 403)
      .json({ error: code || 'EMERGENCY_FALLBACK_APPLY_FAILED', message: (error as Error).message });
  }
});

router.patch('/:workerId/drain', authMiddleware, adminMiddleware, async (req, res) => {
  const parsed = drainSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid drain request', issues: parsed.error.issues });
  try {
    res.json(await setPersistedWorkbenchWorkerDrain(String(req.params.workerId), parsed.data.draining));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Worker drain failed';
    res.status(message === 'WORKER_NOT_REGISTERED' ? 404 : 409).json({ error: message });
  }
});

export default router;
