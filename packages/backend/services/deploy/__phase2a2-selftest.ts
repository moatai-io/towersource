/**
 * Phase 2a-2 self-test — auth-required FastAPI 도구.
 *
 * 1) tool_start (visibility=auth-required, port=8000)
 * 2) Wait for boot
 * 3) URL 받음 → 비로그인 GET 으로 401 확인
 * 4) docker exec curl localhost:8000 으로 컨테이너 자체는 살아있음 확인
 * 5) tool_logs
 * 6) tool_stop (nginx config 도 제거됐는지 확인)
 */
import { sandboxToolStart, sandboxToolStop, sandboxToolLogs } from './sandbox-tools.js';
import { sshExec } from './sandbox-ssh.js';
import { initPg, getPgPool } from '../../db/pg.js';
import { spawn } from 'child_process';

function curl(url: string, opts?: { cookie?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const args = ['-sk', '-o', '/dev/stdout', '-w', '\n__STATUS__:%{http_code}', '--max-time', '10'];
    if (opts?.cookie) args.push('-H', `Cookie: ${opts.cookie}`);
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
  console.log('[pg] ready');

  const userId = 1;
  const name = `auth-${Date.now() % 100000}`;

  console.log(`\n[1/6] tool_start visibility=auth-required name=${name}`);
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
  console.log('[started]', JSON.stringify(started, null, 2));

  if (!started.url) {
    console.error('[FAIL] expected url for auth-required visibility');
    process.exit(1);
  }

  console.log('\n[2/6] wait 5s for uvicorn boot');
  await new Promise(r => setTimeout(r, 5000));

  console.log('\n[3/6] curl 비로그인 → 401 expected');
  const noAuth = await curl(`${started.url}healthz`);
  console.log(`  status=${noAuth.status} body=${noAuth.body.trim().slice(0, 100)}`);
  if (noAuth.status === 401) {
    console.log('  ✅ 401 as expected (no Tower session)');
  } else {
    console.log(`  ❌ expected 401 got ${noAuth.status}`);
  }

  console.log('\n[4/6] docker exec localhost:8000 (컨테이너 자체는 살아있나)');
  let execOut = '';
  await sshExec({
    command: `docker exec ${started.container_id} python -c "import requests; print(requests.get('http://localhost:8000/healthz').text)" 2>&1`,
    timeout_ms: 30_000,
    onStdout: (c) => { execOut += c; },
    onStderr: (c) => { execOut += c; },
  });
  console.log(`  ${execOut.trim()}`);

  console.log('\n[5/6] tool_logs tail');
  const logs = await sandboxToolLogs(started.tool_id, userId, { tail: 30 });
  console.log(logs.slice(-1500));

  console.log('\n[6/6] tool_stop');
  const stopped = await sandboxToolStop(started.tool_id, userId);
  console.log('[stopped]', stopped);

  // verify nginx config removed
  const { existsSync } = await import('fs');
  const slugRow = await getPgPool().query<{ proxy_subdomain: string | null }>(
    'SELECT proxy_subdomain FROM internal_tools WHERE id = $1',
    [started.tool_id],
  );
  console.log('  proxy_subdomain after stop:', slugRow.rows[0]?.proxy_subdomain ?? '(null)');
  // server block 파일은 stop 시 deprovisionTool 이 지움
  const expectedSlug = started.url.replace(/^https?:\/\/([^.]+)\..*/, '$1');
  const cfgPath = `/etc/nginx/sandbox-tools/${expectedSlug}.conf`;
  console.log(`  ${cfgPath} exists?`, existsSync(cfgPath));

  process.exit(0);
}

main().catch(e => {
  console.error('[error]', e);
  process.exit(1);
});
