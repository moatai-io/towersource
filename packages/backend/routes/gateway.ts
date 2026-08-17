/**
 * Central Publish Gateway — receives deployments from self-hosted deployment Towers
 *
 * Only active when TOWER_ROLE=full.
 * Customer Towers (TOWER_ROLE=managed) send tar.gz files here for deployment.
 *
 * Auth: X-Customer-Key header → validated against gateway_customers table
 */
import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import { query, queryOne } from '../db/pg-repo.js';
import { deploy, detectCodeType, deleteDeployment } from '../services/deploy/deploy-engine.js';
import { authMiddleware, adminMiddleware } from '../services/auth/auth.js';

const execFileAsync = promisify(execFile);

const router = Router();

// ── Multer for receiving tar.gz files ──
const gatewayUpload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, _file, cb) => cb(null, `gw-${Date.now()}-${Math.random().toString(36).slice(2)}.tar.gz`),
  }),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB max
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/gzip' || file.mimetype === 'application/x-gzip' || file.originalname.endsWith('.tar.gz')) {
      cb(null, true);
    } else {
      cb(new Error('Only tar.gz files accepted'));
    }
  },
});

// ── Customer API Key Auth Middleware ──

interface GatewayCustomer {
  id: string;
  customer_name: string;
  api_key: string;
  profile: string;
  quota_sites: number;
  quota_apps: number;
  is_active: boolean;
  metadata: Record<string, unknown>;
}

async function gatewayKeyAuth(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers['x-customer-key'] as string;
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing X-Customer-Key header' });
  }

  try {
    const customer = await queryOne<GatewayCustomer>(
      `SELECT * FROM gateway_customers WHERE api_key = $1 AND is_active = true`,
      [apiKey],
    );

    if (!customer) {
      return res.status(403).json({ error: 'Invalid or revoked API key' });
    }

    // Attach customer info to request for downstream use
    (req as any).gatewayCustomer = customer;
    next();
  } catch (err: any) {
    console.error('[gateway] Auth error:', err);
    return res.status(500).json({ error: 'Gateway auth check failed' });
  }
}

// ══════════════════════════════════════════════════════
// Customer-facing endpoints (API key auth)
// ══════════════════════════════════════════════════════

/**
 * POST /api/gateway/publish
 *
 * Receives a tar.gz file from a self-hosted deployment Tower and deploys it.
 * Body: multipart { name, file (tar.gz), type?, target?, port?, description? }
 * Auth: X-Customer-Key header
 */
// ── Env-vars parser (shared by sync + async paths) ──
function parseEnvVars(raw: unknown): Record<string, string> | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) {
      const k = pair.slice(0, eq).trim();
      const v = pair.slice(eq + 1);
      if (k) out[k] = v;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

router.post('/publish', gatewayUpload.single('file'), gatewayKeyAuth, async (req: Request, res: Response) => {
  const customer: GatewayCustomer = (req as any).gatewayCustomer;
  const file = req.file;
  const { name, type, target, port, description, env_vars: envVarsRaw } = req.body;
  const asyncMode = req.query.async === 'true' || req.body.async_mode === 'true';

  const parsedEnv = parseEnvVars(envVarsRaw);

  if (!file) {
    return res.status(400).json({ error: 'No file uploaded. Send tar.gz as "file" field.' });
  }
  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    return res.status(400).json({ error: 'name must be lowercase alphanumeric with hyphens' });
  }

  // Prefix project name with customer to avoid collisions: demo-org--my-report
  const deployName = `${customer.customer_name}--${name}`;
  const extractDir = path.join(os.tmpdir(), `gw-extract-${Date.now()}`);

  // ── Async mode: submit + poll ──
  //
  // Insert a 'queued' row, respond 202 with deploy_id, then run deploy() in
  // the background. The client polls GET /publish/status/:deploy_id to watch
  // progress. Tmp files are owned by the background worker, not this request.
  if (asyncMode) {
    const estimatedType = type || 'unknown';
    const deployRow = await queryOne<{ id: string }>(
      `INSERT INTO gateway_deploy_log (customer_id, deploy_name, deploy_type, deploy_target, success, file_size, status, phase)
       VALUES ($1, $2, $3, $4, false, $5, 'queued', 'queued')
       RETURNING id`,
      [customer.id, name, estimatedType, target || 'unknown', file.size],
    );
    const deployId = deployRow!.id;

    // Respond immediately — caller moves on to polling.
    res.status(202).json({
      deploy_id: deployId,
      status: 'queued',
      status_url: `/api/gateway/publish/status/${deployId}`,
      deployName,
    });

    // Fire-and-forget background worker. Swallows all errors into the DB row.
    runAsyncDeploy({
      deployId,
      customer,
      file,
      extractDir,
      name,
      deployName,
      type,
      target,
      port,
      description,
      parsedEnv,
    }).catch(err => console.error(`[gateway] async deploy ${deployId} crashed:`, err));
    return;
  }

  // ── Sync mode (legacy / static deploys that finish quickly) ──

  try {
    // Check quota (soft-enforced: warn in logs but don't block)
    const deployCount = await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM gateway_deploy_log WHERE customer_id = $1 AND success = true`,
      [customer.id],
    );
    const currentDeploys = parseInt(deployCount?.count || '0');
    const estimatedType = type || 'static';
    const quotaLimit = estimatedType === 'static' ? customer.quota_sites : customer.quota_apps;
    if (currentDeploys >= quotaLimit) {
      console.warn(`[gateway] Customer ${customer.customer_name} at quota limit: ${currentDeploys}/${quotaLimit} (${estimatedType})`);
    }

    // Extract tar.gz to temp dir
    await fs.mkdir(extractDir, { recursive: true });
    await execFileAsync('tar', ['-xzf', file.path, '-C', extractDir], { timeout: 60_000 });

    console.log(`[gateway] Deploying for ${customer.customer_name}: ${deployName} (type: ${estimatedType})`);

    // Auto-detect type if not specified
    const finalType = type || await detectCodeType(extractDir);
    const finalTarget = target || (finalType === 'static' ? 'cloudflare-pages' : 'azure-container-apps');

    // Deploy using existing engine
    const result = await deploy({
      name: deployName,
      sourceDir: extractDir,
      target: finalTarget,
      port: port ? parseInt(port) : undefined,
      env: parsedEnv,
      description: description || `Deployed by ${customer.customer_name}`,
    });

    // Log the deployment
    await query(
      `INSERT INTO gateway_deploy_log (customer_id, deploy_name, deploy_type, deploy_target, result_url, success, error, duration_ms, file_size, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [customer.id, name, finalType, finalTarget, result.url || null, result.success, result.error || null, result.duration || null, file.size, result.success ? 'success' : 'failed'],
    );

    // Update customer's updated_at
    await query(`UPDATE gateway_customers SET updated_at = now() WHERE id = $1`, [customer.id]);

    if (result.success) {
      console.log(`[gateway] Deploy success: ${deployName} → ${result.url}`);
      res.json({
        success: true,
        url: result.url,
        target: result.target,
        detectedType: result.detectedType,
        duration: result.duration,
        deployName,
      });
    } else {
      console.warn(`[gateway] Deploy failed: ${deployName} — ${result.error}`);
      res.status(422).json({
        success: false,
        error: result.error,
        target: result.target,
        detectedType: result.detectedType,
      });
    }

  } catch (err: any) {
    console.error(`[gateway] Error:`, err);
    // Log failed attempt
    try {
      await query(
        `INSERT INTO gateway_deploy_log (customer_id, deploy_name, deploy_type, deploy_target, success, error, file_size, status)
         VALUES ($1, $2, $3, $4, false, $5, $6, 'failed')`,
        [customer.id, name, type || 'unknown', target || 'unknown', err.message, file.size],
      );
    } catch { /* ignore logging errors */ }
    res.status(500).json({ error: err.message });
  } finally {
    // Cleanup
    try { await fs.rm(file.path, { force: true }); } catch {}
    try { await fs.rm(extractDir, { recursive: true, force: true }); } catch {}
  }
});

// ── Async deploy worker ──
//
// Owns tmp file cleanup and DB row progression. Any throw lands in the DB row
// as status='failed' so the client poll always terminates.
interface AsyncDeployCtx {
  deployId: string;
  customer: GatewayCustomer;
  file: Express.Multer.File;
  extractDir: string;
  name: string;
  deployName: string;
  type?: string;
  target?: string;
  port?: string;
  description?: string;
  parsedEnv?: Record<string, string>;
}

async function setPhase(deployId: string, phase: string): Promise<void> {
  try {
    await query(`UPDATE gateway_deploy_log SET phase = $1 WHERE id = $2`, [phase, deployId]);
  } catch (err) {
    console.warn(`[gateway] setPhase(${deployId}, ${phase}) failed:`, err);
  }
}

async function runAsyncDeploy(ctx: AsyncDeployCtx): Promise<void> {
  const { deployId, customer, file, extractDir, deployName, type, target, port, description, parsedEnv } = ctx;

  try {
    await query(
      `UPDATE gateway_deploy_log SET status = 'running', started_at = now(), phase = 'extracting' WHERE id = $1`,
      [deployId],
    );

    // Quota check (soft warn, matches sync path)
    const deployCount = await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM gateway_deploy_log WHERE customer_id = $1 AND success = true`,
      [customer.id],
    );
    const currentDeploys = parseInt(deployCount?.count || '0');
    const estimatedType = type || 'static';
    const quotaLimit = estimatedType === 'static' ? customer.quota_sites : customer.quota_apps;
    if (currentDeploys >= quotaLimit) {
      console.warn(`[gateway] Customer ${customer.customer_name} at quota limit: ${currentDeploys}/${quotaLimit} (${estimatedType})`);
    }

    await fs.mkdir(extractDir, { recursive: true });
    await execFileAsync('tar', ['-xzf', file.path, '-C', extractDir], { timeout: 60_000 });

    const finalType = type || await detectCodeType(extractDir);
    const finalTarget: 'cloudflare-pages' | 'azure-container-apps' =
      (target as any) || (finalType === 'static' ? 'cloudflare-pages' : 'azure-container-apps');

    console.log(`[gateway:${deployId}] async deploy for ${customer.customer_name}: ${deployName} (${finalType} → ${finalTarget})`);

    await setPhase(deployId, finalType === 'static' ? 'deploying' : 'building');

    // Refresh deploy_type/deploy_target now that we've detected them.
    await query(
      `UPDATE gateway_deploy_log SET deploy_type = $1, deploy_target = $2 WHERE id = $3`,
      [finalType, finalTarget, deployId],
    );

    const result = await deploy({
      name: deployName,
      sourceDir: extractDir,
      target: finalTarget,
      port: port ? parseInt(port) : undefined,
      env: parsedEnv,
      description: description || `Deployed by ${customer.customer_name}`,
    });

    await query(`UPDATE gateway_customers SET updated_at = now() WHERE id = $1`, [customer.id]);

    if (result.success) {
      console.log(`[gateway:${deployId}] success → ${result.url}`);
      await query(
        `UPDATE gateway_deploy_log
         SET status = 'success', phase = NULL, success = true,
             result_url = $1, duration_ms = $2, error = NULL
         WHERE id = $3`,
        [result.url || null, result.duration || null, deployId],
      );
    } else {
      console.warn(`[gateway:${deployId}] failed — ${result.error}`);
      await query(
        `UPDATE gateway_deploy_log
         SET status = 'failed', phase = NULL, success = false,
             error = $1, duration_ms = $2
         WHERE id = $3`,
        [result.error || 'Unknown deploy failure', result.duration || null, deployId],
      );
    }
  } catch (err: any) {
    console.error(`[gateway:${deployId}] exception:`, err);
    try {
      await query(
        `UPDATE gateway_deploy_log
         SET status = 'failed', phase = NULL, success = false, error = $1
         WHERE id = $2`,
        [err?.message || String(err), deployId],
      );
    } catch { /* last-resort: row stays 'running' — cold-start cleanup will catch it */ }
  } finally {
    try { await fs.rm(file.path, { force: true }); } catch {}
    try { await fs.rm(extractDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * GET /api/gateway/publish/status/:deploy_id
 *
 * Poll endpoint for async deploys. Returns current status, phase, and (on
 * completion) the deploy URL or error. A customer can only see their own
 * deploys — row ownership is enforced by customer_id match.
 */
router.get('/publish/status/:deploy_id', gatewayKeyAuth, async (req: Request, res: Response) => {
  const customer: GatewayCustomer = (req as any).gatewayCustomer;
  const deployId = String(req.params.deploy_id || '');

  if (!deployId) {
    return res.status(400).json({ error: 'deploy_id required' });
  }

  try {
    const row = await queryOne<{
      id: string;
      customer_id: string;
      deploy_name: string;
      deploy_type: string;
      deploy_target: string;
      result_url: string | null;
      success: boolean;
      error: string | null;
      duration_ms: number | null;
      status: string;
      phase: string | null;
      started_at: string | null;
      created_at: string;
    }>(
      `SELECT id, customer_id, deploy_name, deploy_type, deploy_target, result_url,
              success, error, duration_ms, status, phase, started_at, created_at
       FROM gateway_deploy_log
       WHERE id = $1`,
      [deployId],
    );

    if (!row) {
      return res.status(404).json({ error: 'Deploy not found' });
    }
    if (row.customer_id !== customer.id) {
      return res.status(403).json({ error: 'Not your deploy' });
    }

    res.json({
      deploy_id: row.id,
      deploy_name: row.deploy_name,
      type: row.deploy_type,
      target: row.deploy_target,
      status: row.status,
      phase: row.phase,
      url: row.result_url,
      error: row.error,
      duration_ms: row.duration_ms,
      started_at: row.started_at,
      created_at: row.created_at,
    });
  } catch (err: any) {
    console.error('[gateway] status lookup error:', err);
    res.status(500).json({ error: 'Status lookup failed' });
  }
});

/**
 * Cold-start cleanup — any 'queued' or 'running' row older than 30 minutes
 * is orphaned (process restarted mid-deploy). Mark as failed so client polls
 * terminate instead of hanging forever.
 *
 * Fires once at module load. Keep it defensive — a broken DB at startup
 * should not prevent the server from booting.
 */
(async () => {
  try {
    const { rowCount } = await query(
      `UPDATE gateway_deploy_log
       SET status = 'failed', phase = NULL,
           error = COALESCE(error, 'Gateway restarted before deploy completed')
       WHERE status IN ('queued', 'running')
         AND (started_at IS NULL OR started_at < now() - interval '30 minutes')
         AND created_at < now() - interval '30 minutes'
       RETURNING id` as any,
    ) as any;
    if (rowCount > 0) {
      console.log(`[gateway] cold-start: marked ${rowCount} stalled deploy(s) as failed`);
    }
  } catch (err: any) {
    // Common, benign case on a fresh install: this IIFE runs at module load,
    // before runMigrations() has had a chance to add the gateway_deploy_log
    // table or the `status` column (migration 032). Log a one-liner instead
    // of dumping the whole pg error object — real failures still warn loudly.
    // Postgres SQLSTATE: 42P01 = undefined_table, 42703 = undefined_column.
    if (err?.code === '42P01' || err?.code === '42703') {
      console.log('[gateway] cold-start cleanup skipped — schema not yet migrated (ok on fresh install)');
    } else {
      console.warn('[gateway] cold-start cleanup skipped:', err?.message ?? err);
    }
  }
})();

/**
 * DELETE /api/gateway/publish/:name
 *
 * Tear down a deployment previously created by this customer.
 * Removes: ACA container app (if dynamic), ACR image, Cloudflare Pages
 * project (if static), and the manifest.json entry.
 *
 * Auth: X-Customer-Key header (same as /publish). Customer can only
 * delete deployments under their own "{customer_name}--*" namespace.
 */
router.delete('/publish/:name', gatewayKeyAuth, async (req: Request, res: Response) => {
  const customer: GatewayCustomer = (req as any).gatewayCustomer;
  const rawName = String(req.params.name || '');

  if (!rawName || !/^[a-z0-9][a-z0-9-]*$/.test(rawName)) {
    return res.status(400).json({ error: 'Invalid name. Use lowercase alphanumeric with hyphens.' });
  }

  const deployName = `${customer.customer_name}--${rawName}`;
  // Try app first, then site — deleteDeployment returns "not found" if either misses
  let result = await deleteDeployment(deployName, 'app');
  let kind: 'app' | 'site' = 'app';
  if (!result.success && result.error === 'App not found') {
    result = await deleteDeployment(deployName, 'site');
    kind = 'site';
  }

  // Record the action (re-use gateway_deploy_log with a sentinel target)
  try {
    await query(
      `INSERT INTO gateway_deploy_log (customer_id, deploy_name, deploy_type, deploy_target, success, error)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [customer.id, rawName, 'delete', kind === 'app' ? 'azure-container-apps' : 'cloudflare-pages', result.success, result.error || null],
    );
  } catch { /* logging best-effort */ }

  if (result.success) {
    console.log(`[gateway] Deleted ${kind}: ${deployName}`);
    res.json({ success: true, deleted: deployName, kind });
  } else {
    res.status(result.error?.includes('not found') ? 404 : 500).json({ success: false, error: result.error });
  }
});

/**
 * GET /api/gateway/status
 *
 * Customer-facing status check. Returns this customer's quota usage,
 * last deploy info, and gateway version. Used by self-hosted VMs to show
 * real-time gateway connectivity in their UI.
 *
 * Auth: X-Customer-Key header (same as /publish)
 */
router.get('/status', gatewayKeyAuth, async (req: Request, res: Response) => {
  const customer: GatewayCustomer = (req as any).gatewayCustomer;

  try {
    // Count deployments by type
    const siteDeploys = await queryOne<{ count: string }>(
      `SELECT COUNT(DISTINCT deploy_name) as count FROM gateway_deploy_log
       WHERE customer_id = $1 AND success = true AND deploy_type = 'static'`,
      [customer.id],
    );
    const appDeploys = await queryOne<{ count: string }>(
      `SELECT COUNT(DISTINCT deploy_name) as count FROM gateway_deploy_log
       WHERE customer_id = $1 AND success = true AND deploy_type != 'static'`,
      [customer.id],
    );

    // Fetch all successful deploys (latest record per deploy_name)
    const deploys = await query<{
      deploy_name: string;
      deploy_type: string;
      deploy_target: string;
      result_url: string;
      created_at: string;
      duration_ms: number;
    }>(
      `SELECT DISTINCT ON (deploy_name)
         deploy_name, deploy_type, deploy_target, result_url, created_at, duration_ms
       FROM gateway_deploy_log
       WHERE customer_id = $1 AND success = true
       ORDER BY deploy_name, created_at DESC`,
      [customer.id],
    );

    const deployList = (deploys || []).map(d => ({
      name: d.deploy_name,
      type: d.deploy_type,
      target: d.deploy_target,
      url: d.result_url,
      at: d.created_at,
      durationMs: d.duration_ms,
    }));
    // Sort by most recent
    deployList.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    const lastDeploy = deployList[0] || null;

    res.json({
      connected: true,
      customer: customer.customer_name,
      profile: customer.profile,
      quotas: {
        sites: { used: parseInt(siteDeploys?.count || '0'), limit: customer.quota_sites },
        apps: { used: parseInt(appDeploys?.count || '0'), limit: customer.quota_apps },
      },
      lastDeploy,
      deploys: deployList,
      gatewayVersion: '1.0.0',
      checkedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('[gateway] Status check error:', err);
    res.status(500).json({ error: 'Failed to fetch gateway status' });
  }
});

// ══════════════════════════════════════════════════════
// Admin endpoints (Tower admin auth)
// ══════════════════════════════════════════════════════

/** Generate a customer API key: cust_<name>_<random> */
function generateApiKey(customerName: string): string {
  const rand = crypto.randomBytes(16).toString('hex');
  return `cust_${customerName}_${rand}`;
}

/** GET /api/gateway/customers — List all gateway customers */
router.get('/customers', authMiddleware, adminMiddleware, async (_req: Request, res: Response) => {
  try {
    const customers = await query(
      `SELECT id, customer_name, api_key, profile, quota_sites, quota_apps, is_active, metadata, created_at, updated_at
       FROM gateway_customers ORDER BY created_at DESC`,
    );
    // Also fetch deploy counts
    const counts = await query(
      `SELECT customer_id, COUNT(*) as total, COUNT(*) FILTER (WHERE success) as successful
       FROM gateway_deploy_log GROUP BY customer_id`,
    );
    const countMap = new Map((counts || []).map((c: any) => [c.customer_id, { total: +c.total, successful: +c.successful }]));

    const result = (customers || []).map((c: any) => ({
      ...c,
      deploys: countMap.get(c.id) || { total: 0, successful: 0 },
    }));

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/gateway/customers — Register a new customer */
router.post('/customers', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const { customer_name, profile, quota_sites, quota_apps, metadata } = req.body;
    if (!customer_name) return res.status(400).json({ error: 'customer_name required' });
    if (!/^[a-z0-9][a-z0-9-]*$/.test(customer_name)) {
      return res.status(400).json({ error: 'customer_name must be lowercase alphanumeric with hyphens' });
    }

    // Check duplicate
    const existing = await queryOne(`SELECT id FROM gateway_customers WHERE customer_name = $1`, [customer_name]);
    if (existing) return res.status(409).json({ error: `Customer '${customer_name}' already exists` });

    const apiKey = generateApiKey(customer_name);
    const customer = await queryOne(
      `INSERT INTO gateway_customers (customer_name, api_key, profile, quota_sites, quota_apps, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [customer_name, apiKey, profile || 'basic', quota_sites || 10, quota_apps || 5, JSON.stringify(metadata || {})],
    );

    console.log(`[gateway] Customer registered: ${customer_name} (key: ${apiKey.slice(0, 20)}...)`);
    res.status(201).json(customer);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** PATCH /api/gateway/customers/:id — Update customer config */
router.patch('/customers/:id', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { profile, quota_sites, quota_apps, is_active, metadata } = req.body;

    const sets: string[] = [];
    const vals: any[] = [];
    let idx = 1;

    if (profile !== undefined) { sets.push(`profile = $${idx++}`); vals.push(profile); }
    if (quota_sites !== undefined) { sets.push(`quota_sites = $${idx++}`); vals.push(quota_sites); }
    if (quota_apps !== undefined) { sets.push(`quota_apps = $${idx++}`); vals.push(quota_apps); }
    if (is_active !== undefined) { sets.push(`is_active = $${idx++}`); vals.push(is_active); }
    if (metadata !== undefined) { sets.push(`metadata = $${idx++}`); vals.push(JSON.stringify(metadata)); }

    if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });

    sets.push(`updated_at = now()`);
    vals.push(id);

    const customer = await queryOne(
      `UPDATE gateway_customers SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      vals,
    );

    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    res.json(customer);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /api/gateway/customers/:id — Soft-delete (deactivate) a customer */
router.delete('/customers/:id', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await queryOne(
      `UPDATE gateway_customers SET is_active = false, updated_at = now() WHERE id = $1 RETURNING customer_name`,
      [id],
    );
    if (!result) return res.status(404).json({ error: 'Customer not found' });
    console.log(`[gateway] Customer deactivated: ${(result as any).customer_name}`);
    res.json({ success: true, message: `Customer '${(result as any).customer_name}' deactivated` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/gateway/customers/:id/rotate-key — Generate new API key */
router.post('/customers/:id/rotate-key', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const customer = await queryOne<GatewayCustomer>(`SELECT * FROM gateway_customers WHERE id = $1`, [id]);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const newKey = generateApiKey(customer.customer_name);
    await query(`UPDATE gateway_customers SET api_key = $1, updated_at = now() WHERE id = $2`, [newKey, id]);

    console.log(`[gateway] API key rotated for: ${customer.customer_name}`);
    res.json({ api_key: newKey, message: 'Key rotated. Update the customer server .env immediately.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/gateway/deploys — Deploy history (admin) */
router.get('/deploys', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;

    const deploys = await query(
      `SELECT d.*, c.customer_name
       FROM gateway_deploy_log d
       JOIN gateway_customers c ON c.id = d.customer_id
       ORDER BY d.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    res.json(deploys || []);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
// DNS Management (admin only)
// ══════════════════════════════════════════════════════
import {
  createWildcardForCustomer, getCustomerDnsStatus,
  listCustomerWildcards, removeCustomerDns,
} from '../services/deploy/cloudflare-dns.js';

/** POST /api/gateway/customers/:id/setup-dns — Create wildcard DNS for customer */
router.post('/customers/:id/setup-dns', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const customer = await queryOne<GatewayCustomer>(`SELECT * FROM gateway_customers WHERE id = $1`, [id]);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const { ip } = req.body;
    if (!ip) return res.status(400).json({ error: 'ip is required (self-hosted server IP address)' });

    const result = await createWildcardForCustomer(customer.customer_name, ip);
    res.json({
      customer: customer.customer_name,
      domain: `*.${customer.customer_name}.tower.example.com`,
      ip,
      ...result,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/gateway/customers/:id/dns — Check DNS status for customer */
router.get('/customers/:id/dns', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const customer = await queryOne<GatewayCustomer>(`SELECT * FROM gateway_customers WHERE id = $1`, [id]);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const status = await getCustomerDnsStatus(customer.customer_name);
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /api/gateway/customers/:id/dns — Remove customer DNS records */
router.delete('/customers/:id/dns', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const customer = await queryOne<GatewayCustomer>(`SELECT * FROM gateway_customers WHERE id = $1`, [id]);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const result = await removeCustomerDns(customer.customer_name);
    res.json({ customer: customer.customer_name, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/gateway/dns/wildcards — List all customer wildcard DNS records */
router.get('/dns/wildcards', authMiddleware, adminMiddleware, async (_req: Request, res: Response) => {
  try {
    const wildcards = await listCustomerWildcards();
    res.json(wildcards);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
