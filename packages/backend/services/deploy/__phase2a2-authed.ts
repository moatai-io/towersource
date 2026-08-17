/**
 * Phase 2a-2 자가검증 후속 — 로그인 token cookie 로 200 받는지.
 *
 * admin (id=1) 의 valid JWT 만들고 tower_token cookie 로 curl.
 */
import { sandboxToolStart, sandboxToolStop } from './sandbox-tools.js';
import { initPg } from '../../db/pg.js';
import { generateToken } from '../auth/auth.js';
import { spawn } from 'child_process';

function curl(url: string, cookie?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const args = ['-sk', '-o', '/dev/stdout', '-w', '\n__STATUS__:%{http_code}', '--max-time', '15'];
    if (cookie) args.push('-H', `Cookie: ${cookie}`);
    args.push(url);
    const proc = spawn('curl', args);
    let out = '';
    proc.stdout.on('data', d => { out += d.toString('utf8'); });
    proc.on('error', reject);
    proc.on('close', () => {
      const m = out.match(/__STATUS__:(\d+)/);
      resolve({ status: m ? parseInt(m[1], 10) : 0, body: out.replace(/\n?__STATUS__:\d+/, '') });
    });
  });
}

async function main() {
  await initPg();
  const userId = 1;
  const token = generateToken({ userId, username: 'admin', role: 'admin' });
  const cookie = `tower_token=${token}`;

  const name = `authed-${Date.now() % 100000}`;
  console.log(`[start] visibility=auth-required name=${name}`);
  const started = await sandboxToolStart({
    userId,
    name,
    runtime: 'python-web',
    workspace_path: 'projects/tower/experiments/phase2a1-fastapi',
    entrypoint: 'uvicorn main:app --host 0.0.0.0 --port 8000',
    port: 8000,
    visibility: 'auth-required',
    expires_in_days: 1,
  });
  console.log('[url]', started.url);

  await new Promise(r => setTimeout(r, 6000));

  // tunnel 진단
  const { listSshTunnels } = await import('./sandbox-ssh.js');
  console.log('[diag] active tunnels:', listSshTunnels());

  // 본체 localhost:hostPort 직접 (tunnel 검증)
  const hostPort = started.host_port;
  if (hostPort !== null) {
    const direct = await curl(`http://127.0.0.1:${hostPort}/healthz`);
    console.log(`[diag] localhost:${hostPort} direct → status=${direct.status} body=${direct.body.trim().slice(0,100)}`);
  }

  console.log('\n[비로그인]');
  const noAuth = await curl(`${started.url}healthz`);
  console.log(`  status=${noAuth.status}`);

  console.log('\n[로그인 cookie 로]');
  const authed = await curl(`${started.url}healthz`, cookie);
  console.log(`  status=${authed.status} body=${authed.body.trim().slice(0, 200)}`);

  console.log('\n[stop]');
  await sandboxToolStop(started.tool_id, userId);
  console.log('  done');

  process.exit(0);
}

main().catch(e => { console.error('[error]', e); process.exit(1); });
