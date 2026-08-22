/**
 * Publish Client — used by TOWER_ROLE=managed self-hosts
 *
 * Packages a source directory into tar.gz and sends it to the explicitly
 * configured organization Publish Gateway. Standalone self-hosts do not use
 * or depend on this client.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { config } from '../config.js';
import { updateManifestAfterDeploy } from './deploy/deploy-engine.js';

const execFileAsync = promisify(execFile);

export interface GatewayPublishOptions {
  name: string;
  sourceDir: string;
  type?: 'static' | 'dynamic';
  target?: string;
  port?: number;
  description?: string;
}

export interface GatewayPublishResult {
  success: boolean;
  url?: string;
  target?: string;
  detectedType?: string;
  error?: string;
  duration?: number;
}

/**
 * Package sourceDir into tar.gz, POST to the central gateway.
 *
 * Flow:
 *   1. tar.gz the source directory
 *   2. POST multipart/form-data to PUBLISH_GATEWAY_URL
 *   3. Return the gateway's response (deploy result)
 */
// ── Gateway Status Check (with cache) ──

export interface GatewayStatus {
  connected: boolean;
  customer?: string;
  profile?: string;
  quotas?: {
    sites: { used: number; limit: number };
    apps: { used: number; limit: number };
  };
  lastDeploy?: {
    name: string;
    type: string;
    url?: string;
    at: string;
    durationMs?: number;
  } | null;
  deploys?: Array<{
    name: string;
    type: string;
    target?: string;
    url?: string;
    at: string;
    durationMs?: number;
  }>;
  gatewayVersion?: string;
  checkedAt: string;
  error?: string;
  latencyMs?: number;
}

let _statusCache: GatewayStatus | null = null;
let _statusCacheTime = 0;
const STATUS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Check gateway connectivity and fetch this customer's status.
 * Results are cached for 5 minutes unless force=true.
 */
export async function checkGatewayStatus(force = false): Promise<GatewayStatus> {
  const now = Date.now();
  if (!force && _statusCache && (now - _statusCacheTime) < STATUS_CACHE_TTL) {
    return _statusCache;
  }

  const { publishGatewayUrl, publishApiKey } = config;

  if (!publishGatewayUrl || !publishApiKey) {
    const result: GatewayStatus = {
      connected: false,
      checkedAt: new Date().toISOString(),
      error: !publishGatewayUrl ? 'PUBLISH_GATEWAY_URL not configured' : 'PUBLISH_API_KEY not configured',
    };
    _statusCache = result;
    _statusCacheTime = now;
    return result;
  }

  // Derive /status URL from the publish URL (replace /publish with /status)
  const statusUrl = publishGatewayUrl.replace(/\/publish$/, '/status');

  const start = Date.now();
  try {
    const response = await fetch(statusUrl, {
      method: 'GET',
      headers: { 'X-Customer-Key': publishApiKey },
      signal: AbortSignal.timeout(5000), // 5s timeout
    });

    const latencyMs = Date.now() - start;

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      const result: GatewayStatus = {
        connected: false,
        checkedAt: new Date().toISOString(),
        latencyMs,
        error: response.status === 401 || response.status === 403
          ? 'API key invalid or revoked'
          : `Gateway returned ${response.status}: ${errText.slice(0, 200)}`,
      };
      _statusCache = result;
      _statusCacheTime = now;
      return result;
    }

    const data = await response.json();
    const result: GatewayStatus = { ...data, latencyMs };
    _statusCache = result;
    _statusCacheTime = now;
    return result;

  } catch (err: any) {
    const latencyMs = Date.now() - start;
    const result: GatewayStatus = {
      connected: false,
      checkedAt: new Date().toISOString(),
      latencyMs,
      error: err.name === 'TimeoutError' || err.name === 'AbortError'
        ? 'Gateway unreachable (timeout 5s)'
        : `Connection failed: ${err.message}`,
    };
    _statusCache = result;
    _statusCacheTime = now;
    return result;
  }
}

// ── Gateway Publish ──

export async function publishViaGateway(opts: GatewayPublishOptions): Promise<GatewayPublishResult> {
  const { publishGatewayUrl, publishApiKey } = config;

  if (!publishGatewayUrl) {
    return { success: false, error: 'PUBLISH_GATEWAY_URL is not configured. Set it in .env' };
  }
  if (!publishApiKey) {
    return { success: false, error: 'PUBLISH_API_KEY is not configured. Set it in .env' };
  }

  // Validate source directory
  try {
    await fs.access(opts.sourceDir);
  } catch {
    return { success: false, error: `Source directory not found: ${opts.sourceDir}` };
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-publish-'));
  const tarPath = path.join(tmpDir, 'source.tar.gz');

  try {
    // Step 1: Create tar.gz of source directory
    console.log(`[publish-client] Packaging ${opts.sourceDir} → ${tarPath}`);
    await execFileAsync('tar', [
      '-czf', tarPath,
      '-C', opts.sourceDir,
      '.',
    ], { timeout: 60_000 });

    const stat = await fs.stat(tarPath);
    console.log(`[publish-client] Package size: ${(stat.size / 1024).toFixed(1)} KB`);

    // Step 2: POST to gateway using fetch (Node 18+ built-in)
    const fileBuffer = await fs.readFile(tarPath);
    const blob = new Blob([fileBuffer], { type: 'application/gzip' });

    const formData = new FormData();
    formData.append('name', opts.name);
    formData.append('file', blob, 'source.tar.gz');
    if (opts.type) formData.append('type', opts.type);
    if (opts.target) formData.append('target', opts.target);
    if (opts.port) formData.append('port', String(opts.port));
    if (opts.description) formData.append('description', opts.description);

    console.log(`[publish-client] Sending to gateway: ${publishGatewayUrl}`);
    const response = await fetch(publishGatewayUrl, {
      method: 'POST',
      headers: {
        'X-Customer-Key': publishApiKey,
      },
      body: formData,
    });

    if (!response.ok) {
      const errBody = await response.text();
      let errMsg: string;
      try {
        const errJson = JSON.parse(errBody);
        errMsg = errJson.error || errBody;
      } catch {
        errMsg = errBody;
      }
      return { success: false, error: `Gateway error (${response.status}): ${errMsg}` };
    }

    const result: GatewayPublishResult = await response.json();
    console.log(`[publish-client] Gateway response:`, result);

    // F2 fix (2026-04-19): on success, update local manifest so Publishing Hub UI
    // reflects the deploy. Without this, self-hosted VMs see an empty local manifest
    // even though the deploy succeeded centrally — users perceive "sync gap."
    // Non-fatal: manifest failures must not break the publish result.
    if (result.success) {
      try {
        const detectedType: 'static' | 'dynamic' =
          result.detectedType === 'dynamic' ? 'dynamic' : 'static';
        const target = (result.target || (detectedType === 'static' ? 'cloudflare-pages' : 'azure-container-apps')) as any;
        await updateManifestAfterDeploy(
          {
            name: opts.name,
            sourceDir: opts.sourceDir,
            target: opts.target as any,
            port: opts.port,
            description: opts.description,
          },
          {
            success: true,
            target,
            detectedType,
            url: result.url,
            duration: result.duration,
          },
        );
        console.log(`[publish-client] Local manifest updated: ${opts.name} → ${result.url}`);
      } catch (e: any) {
        console.warn(`[publish-client] Local manifest update failed (non-fatal): ${e?.message || e}`);
      }
    }

    return result;

  } catch (err: any) {
    console.error(`[publish-client] Failed:`, err);
    return { success: false, error: err.message || 'Unknown error during gateway publish' };
  } finally {
    // Cleanup temp directory
    try {
      await fs.rm(tmpDir, { recursive: true });
    } catch { /* ignore */ }
  }
}
