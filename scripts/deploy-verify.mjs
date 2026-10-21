#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { execFile } from 'child_process';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import WebSocket from 'ws';
import {
  buildHealthUrl,
  buildWsUrl,
  extractJwtSecret,
  getPm2ProcessStatus,
  healthLooksOk,
} from './deploy-verify-lib.mjs';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs(argv) {
  const args = {
    target: 'tower-prod',
    baseUrl: 'http://127.0.0.1:32364',
    timeoutSec: 60,
    intervalMs: 2000,
    projectRoot: path.resolve(__dirname, '..'),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--target') {
      args.target = argv[++i];
    } else if (arg === '--base-url') {
      args.baseUrl = argv[++i];
    } else if (arg === '--timeout') {
      args.timeoutSec = Number(argv[++i]);
    } else if (arg === '--interval-ms') {
      args.intervalMs = Number(argv[++i]);
    } else if (arg === '--project-root') {
      args.projectRoot = path.resolve(argv[++i]);
    }
  }

  return args;
}

function usage() {
  return [
    'Usage: node scripts/deploy-verify.mjs [options]',
    '',
    'Options:',
    '  --target <name>        PM2 target name (default: tower-prod)',
    '  --base-url <url>       Base URL to verify (default: http://127.0.0.1:32364)',
    '  --timeout <sec>        Total timeout in seconds (default: 60)',
    '  --interval-ms <ms>     Poll interval in ms (default: 2000)',
    '  --project-root <path>  Project root containing .env (default: repo root)',
  ].join('\n');
}

function log(message) {
  console.log(`[deploy-verify] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractEnvValue(envText, name) {
  const prefix = `${name}=`;
  for (const line of envText.split('\n')) {
    if (!line.startsWith(prefix)) continue;
    const raw = line.slice(prefix.length).trim();
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      return raw.slice(1, -1);
    }
    return raw;
  }
  return '';
}

async function readCheckoutRuntime(projectRoot) {
  const envText = fs.readFileSync(path.join(projectRoot, '.env'), 'utf8');
  return {
    secret: extractJwtSecret(envText),
    databaseUrl: extractEnvValue(envText, 'DATABASE_URL'),
  };
}

async function readPm2Runtime(target) {
  const { stdout } = await execFileAsync('pm2', ['jlist']);
  const parsed = JSON.parse(stdout || '[]');
  const proc = parsed.find((item) => item?.name === target);
  return {
    secret: proc?.pm2_env?.JWT_SECRET || '',
    databaseUrl: proc?.pm2_env?.DATABASE_URL || '',
  };
}

async function readRepresentativeUser(databaseUrls) {
  const candidates = [...new Set(databaseUrls.filter(Boolean))];
  const errors = [];
  for (const connectionString of candidates) {
    const client = new pg.Client({ connectionString });
    try {
      await client.connect();
      const result = await client.query(`
        SELECT id, username, role, auth_epoch
          FROM users
         WHERE COALESCE(disabled, 0) = 0
           AND COALESCE(approval_status, 'active') = 'active'
         ORDER BY CASE WHEN role NOT IN ('admin', 'operator') THEN 0 ELSE 1 END,
                  id
         LIMIT 1
      `);
      if (result.rows[0]) return result.rows[0];
      errors.push('database has no active representative user');
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    } finally {
      await client.end().catch(() => {});
    }
  }
  throw new Error(`Unable to select active representative user: ${errors.join(' | ') || 'DATABASE_URL missing'}`);
}

function buildJwtTokens(secrets, user) {
  return [...new Set(secrets.filter(Boolean))].map((secret) => jwt.sign({
    userId: Number(user.id),
    username: user.username,
    role: user.role,
    authEpoch: Number(user.auth_epoch ?? 0),
  }, secret, { expiresIn: '5m' }));
}

async function waitForPm2Online(target, timeoutSec, intervalMs) {
  const deadline = Date.now() + timeoutSec * 1000;
  let lastStatus = 'missing';

  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync('pm2', ['jlist']);
      const parsed = JSON.parse(stdout || '[]');
      lastStatus = getPm2ProcessStatus(parsed, target) || 'missing';
      if (lastStatus === 'online') {
        log(`PM2 target is online: ${target}`);
        return;
      }
    } catch (err) {
      lastStatus = err instanceof Error ? err.message : String(err);
    }

    await sleep(intervalMs);
  }

  throw new Error(`PM2 target did not become online: ${target} (last=${lastStatus})`);
}

async function waitForHealth(baseUrl, token, timeoutSec, intervalMs) {
  const deadline = Date.now() + timeoutSec * 1000;
  const healthUrl = buildHealthUrl(baseUrl);
  let lastMessage = 'no response';

  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const body = await res.text();
      let payload = null;
      try { payload = JSON.parse(body); } catch {}
      if (res.ok && healthLooksOk(payload)) {
        log(`Health endpoint is ok: ${healthUrl}`);
        return;
      }
      lastMessage = `status=${res.status} body=${body.slice(0, 200)}`;
    } catch (err) {
      lastMessage = err instanceof Error ? err.message : String(err);
    }

    await sleep(intervalMs);
  }

  throw new Error(`Health endpoint did not become ready: ${lastMessage}`);
}

async function waitForWsConnected(baseUrl, token, timeoutSec) {
  const wsUrl = buildWsUrl(baseUrl, token || undefined);
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (error) reject(error);
      else resolve(undefined);
    };
    const timer = setTimeout(() => {
      finish(new Error(`Timed out waiting for WS connected message: ${wsUrl}`));
    }, timeoutSec * 1000);

    ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        if (data?.type === 'connected') finish();
      } catch {}
    });

    ws.on('error', (err) => finish(err));
    ws.on('close', (code, reason) => {
      if (!settled) finish(new Error(`WebSocket closed before connected message (code=${code}, reason=${reason.toString() || 'none'})`));
    });
  });

  log(`WebSocket connected message verified: ${wsUrl.replace(/([?&]token=)[^&]+/, '$1***')}`);
}

async function waitForWsConnectedWithCandidates(baseUrl, tokens, timeoutSec) {
  const candidates = [...new Set(tokens.filter(Boolean))];
  if (candidates.length === 0) return waitForWsConnected(baseUrl, null, timeoutSec);
  const deadline = Date.now() + timeoutSec * 1000;
  const errors = [];
  for (const token of candidates) {
    const remainingSec = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
    try {
      await waitForWsConnected(baseUrl, token, remainingSec);
      return;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`No runtime JWT candidate authenticated WebSocket: ${errors.join(' | ')}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }

  log(`Starting deploy verification for ${args.target} @ ${args.baseUrl}`);
  await waitForPm2Online(args.target, args.timeoutSec, args.intervalMs);
  // During authority transitions PM2 and the checkout can temporarily expose
  // different runtime credentials. Health is public, while WebSocket auth must
  // use an account that the current database still considers active.
  const pm2Runtime = await readPm2Runtime(args.target).catch(() => ({ secret: '', databaseUrl: '' }));
  const checkoutRuntime = await readCheckoutRuntime(args.projectRoot).catch(() => ({ secret: '', databaseUrl: '' }));
  const representativeUser = await readRepresentativeUser([
    pm2Runtime.databaseUrl,
    checkoutRuntime.databaseUrl,
  ]);
  const tokens = buildJwtTokens([
    pm2Runtime.secret,
    checkoutRuntime.secret,
  ], representativeUser);
  await waitForHealth(args.baseUrl, null, args.timeoutSec, args.intervalMs);
  await waitForWsConnectedWithCandidates(args.baseUrl, tokens, Math.min(args.timeoutSec, 20));

  log('Verification passed');
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[deploy-verify] FAILED: ${message}`);
  process.exit(1);
});
