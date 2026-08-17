/**
 * Phase 2a-1 self-test — bypass MCP, drive sandbox-tools.ts directly.
 * Run: cd ~/tower && npx tsx packages/backend/services/deploy/__phase2a1-selftest.ts
 *
 * 1) start FastAPI uvicorn container (private visibility, port=8000)
 * 2) wait for boot
 * 3) docker exec python -c 'requests.get localhost:8000/healthz'
 * 4) tool_logs tail
 * 5) tool_stop
 */
import { sandboxToolStart, sandboxToolStop, sandboxToolList, sandboxToolLogs } from './sandbox-tools.js';
import { sshExec } from './sandbox-ssh.js';
import { initPg } from '../../db/pg.js';

async function main() {
  await initPg();
  console.log('[pg] ready');

  const userId = 1;  // admin
  const name = `selftest-${Date.now() % 100000}`;

  console.log(`[start] ${name}`);
  const started = await sandboxToolStart({
    userId,
    name,
    runtime: 'python-web',
    workspace_path: 'projects/tower/experiments/phase2a1-fastapi',
    entrypoint: 'uvicorn main:app --host 0.0.0.0 --port 8000',
    port: 8000,
    expires_in_days: 1,
  });
  console.log('[started]', JSON.stringify(started, null, 2));

  await new Promise(r => setTimeout(r, 5000));

  const tools = await sandboxToolList({ userId });
  const me = tools.find(t => t.id === started.tool_id);
  console.log('[list]', { id: me?.id, status: me?.status, container_id: me?.container_id?.slice(0,12), expires_at: me?.expires_at });

  // docker exec — python-web 이미지에 requests 사전 설치됨
  console.log('[exec /healthz via requests]');
  let curlOut = '';
  await sshExec({
    command: `docker exec ${started.container_id} python -c "import requests; print(requests.get('http://localhost:8000/healthz').text)" 2>&1`,
    timeout_ms: 30_000,
    onStdout: (c) => { curlOut += c; },
    onStderr: (c) => { curlOut += c; },
  });
  console.log('[output]', curlOut.trim());

  console.log('[exec / via requests]');
  let rootOut = '';
  await sshExec({
    command: `docker exec ${started.container_id} python -c "import requests; print(requests.get('http://localhost:8000/').text)" 2>&1`,
    timeout_ms: 30_000,
    onStdout: (c) => { rootOut += c; },
    onStderr: (c) => { rootOut += c; },
  });
  console.log('[output]', rootOut.trim());

  const logs = await sandboxToolLogs(started.tool_id, userId, { tail: 50 });
  console.log('[logs tail (last 1500)]', logs.slice(-1500));

  const stopped = await sandboxToolStop(started.tool_id, userId);
  console.log('[stopped]', stopped);

  process.exit(0);
}

main().catch(e => {
  console.error('[error]', e);
  process.exit(1);
});
