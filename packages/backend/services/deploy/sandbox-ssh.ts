/**
 * sandbox-ssh.ts — ssh exec wrapper to the execution VM.
 *
 * Tower 본체 인스턴스가 자기 1:1 execution VM 에 docker 명령을 위임할 때 쓰는
 * 단일 진입점. Phase 1 통신 모델은 ssh exec — 단순함·디버깅·표준 인증 우선.
 * Phase 2 트래픽 늘어나면 Docker remote API(TCP/TLS) 전환 검토.
 *
 * Decision: workspace/decisions/2026-04-24-execution-sandbox-scope.md (D2, D8)
 * Plan:     docs/plans/2026-04-26-execution-sandbox-phase1.md (1a)
 *
 * 이 파일은 *통신 layer* 만 담당. Sandbox 정책 (사용자 토글, 쿼터, 감사,
 * 컨테이너 라이프사이클)은 별도 sandbox.ts(Phase 1b)에서 다룬다.
 */

import { spawn } from 'child_process';
import { config } from '../../config.js';

export interface SshExecOptions {
  /** 원격에서 실행할 명령. 이미 docker run ... 형태로 완전히 구성되어야 함. */
  command: string;
  /** 0 또는 미지정 → 무제한. ms 단위. */
  timeout_ms?: number;
  /** stdout 청크 콜백 (실시간 스트리밍용). */
  onStdout?: (chunk: string) => void;
  /** stderr 청크 콜백. */
  onStderr?: (chunk: string) => void;
  /** stdin 으로 보낼 데이터 (선택). */
  stdin?: string;
}

export interface SshExecResult {
  exit_code: number;
  duration_ms: number;
  stdout_size: number;
  stderr_size: number;
  /** killer 가 timeout 으로 SIGKILL 보낸 경우 true. */
  killed_by_timeout: boolean;
}

/**
 * ssh exec — execution VM 에 한 줄짜리 명령을 보내고 종료까지 기다림.
 *
 * - BatchMode=yes: 비밀번호 프롬프트가 뜨면 즉시 실패 (CI/서비스 환경 안전장치)
 * - StrictHostKeyChecking=accept-new: 첫 접속만 자동 등록, 이후 변조 거부
 * - 호스트 alias 는 ~/.ssh/config 에서 해석 (D8: EXECUTION_VM_HOST=exec-tower)
 */
export async function sshExec(opts: SshExecOptions): Promise<SshExecResult> {
  const cfg = config.sandbox;
  if (!cfg.vmHost) {
    throw new Error('sandbox-ssh: EXECUTION_VM_HOST is not set');
  }

  const sshArgs: string[] = [
    '-o', `ConnectTimeout=${cfg.sshTimeoutSec}`,
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=10',
    '-o', 'ServerAliveCountMax=3',
  ];

  if (cfg.vmKeyPath) {
    sshArgs.push('-i', cfg.vmKeyPath);
  }

  const userHost = cfg.vmHost.includes('@') ? cfg.vmHost : `${cfg.vmUser}@${cfg.vmHost}`;
  sshArgs.push(userHost, opts.command);

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const proc = spawn('ssh', sshArgs);

    let stdoutSize = 0;
    let stderrSize = 0;
    let killedByTimeout = false;

    proc.stdout.on('data', (d: Buffer) => {
      stdoutSize += d.length;
      opts.onStdout?.(d.toString('utf8'));
    });
    proc.stderr.on('data', (d: Buffer) => {
      stderrSize += d.length;
      opts.onStderr?.(d.toString('utf8'));
    });

    if (opts.stdin) {
      proc.stdin.end(opts.stdin);
    }

    let killTimer: NodeJS.Timeout | null = null;
    if (opts.timeout_ms && opts.timeout_ms > 0) {
      killTimer = setTimeout(() => {
        killedByTimeout = true;
        // ssh 자체 + 원격 프로세스 모두 종료. ssh 는 SIGKILL 받으면 원격 ttl 끊김.
        proc.kill('SIGKILL');
      }, opts.timeout_ms);
    }

    proc.on('error', (err) => {
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });

    proc.on('close', (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      resolve({
        exit_code: code ?? (signal ? -1 : -1),
        duration_ms: Date.now() - startedAt,
        stdout_size: stdoutSize,
        stderr_size: stderrSize,
        killed_by_timeout: killedByTimeout,
      });
    });
  });
}

// ── SSH Tunnel (Phase 2a-2) ────────────────────────────────────────────
// 본체 VM ↔ sibling sandbox VM 사이 inbound port forwarding.
// auth-required 도구가 sibling 의 host_port 에서 listen 중인 컨테이너를
// 본체 nginx 가 호출할 수 있게 본체 localhost:host_port 로 forward.
//
// 보안 모델 (Q14a-1 후속, 이 모듈에서 박음):
//   - sibling 의 host_port 는 docker --publish 127.0.0.1:hp:cp 로 *외부 0 노출*
//   - 본체에서만 ssh tunnel 통해 sibling localhost:hp 도달
//   - 외부 → 본체 nginx → 본체 127.0.0.1:hp (tunnel) → sibling 127.0.0.1:hp → 컨테이너
//
// Lifecycle:
//   - tool_start 시 startSshTunnel(toolId, hostPort) 호출
//   - tool_stop 시 stopSshTunnel(toolId)
//   - Tower restart 시 internal_tools.status='running' 인 도구들에 대해 재생성
//     (sandbox-tools.ts 의 cron 또는 startup hook 가 책임)

import type { ChildProcess } from 'child_process';

interface TunnelEntry {
  proc: ChildProcess;
  hostPort: number;
  startedAt: number;
}

const tunnels = new Map<number, TunnelEntry>();

/**
 * Forward 본체 127.0.0.1:port → sibling 127.0.0.1:port via ssh tunnel.
 * 같은 toolId 에 대해 이미 떠있으면 no-op.
 */
export async function startSshTunnel(toolId: number, hostPort: number): Promise<void> {
  const existing = tunnels.get(toolId);
  if (existing && !existing.proc.killed) return;

  const cfg = config.sandbox;
  if (!cfg.vmHost) throw new Error('EXECUTION_VM_HOST not set');

  const userHost = cfg.vmHost.includes('@') ? cfg.vmHost : `${cfg.vmUser}@${cfg.vmHost}`;
  const sshArgs: string[] = [
    '-o', `ConnectTimeout=${cfg.sshTimeoutSec}`,
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=4',
    '-o', 'ExitOnForwardFailure=yes',
    '-N',                                   // no remote command — tunnel only
    '-L', `127.0.0.1:${hostPort}:127.0.0.1:${hostPort}`,
  ];
  if (cfg.vmKeyPath) sshArgs.push('-i', cfg.vmKeyPath);
  sshArgs.push(userHost);

  const proc = spawn('ssh', sshArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.unref();
  tunnels.set(toolId, { proc, hostPort, startedAt: Date.now() });

  proc.on('exit', (code, signal) => {
    const e = tunnels.get(toolId);
    if (e?.proc === proc) {
      tunnels.delete(toolId);
      console.warn(`[ssh-tunnel] tool=${toolId} port=${hostPort} exited code=${code} signal=${signal}`);
    }
  });

  // ssh -L 의 listen socket 이 실제로 활성화되기까지 짧은 대기
  await new Promise(r => setTimeout(r, 500));
}

export function stopSshTunnel(toolId: number): boolean {
  const entry = tunnels.get(toolId);
  if (!entry) return false;
  try {
    entry.proc.kill('SIGTERM');
  } catch { /* ignore */ }
  tunnels.delete(toolId);
  return true;
}

export function listSshTunnels(): Array<{ toolId: number; hostPort: number; startedAt: number; alive: boolean }> {
  return Array.from(tunnels.entries()).map(([toolId, e]) => ({
    toolId,
    hostPort: e.hostPort,
    startedAt: e.startedAt,
    alive: !e.proc.killed,
  }));
}

/**
 * 부팅 시 1회 호출 — 4계층 토글 1단계(서버 .env)와 ssh 도달성을 동시 검증.
 *
 * Returns:
 *   { ok: true }                           — sandbox 활성, MCP/도구 등록 OK
 *   { ok: false, reason: string }          — 비활성. reason 을 로그에 남기고
 *                                            sandbox 도구 등록 skip.
 *
 * Phase 1 1a 자가 검증 항목.
 */
export async function verifySandboxConnectivity(): Promise<{ ok: boolean; reason?: string }> {
  const cfg = config.sandbox;

  if (!cfg.enabled) {
    return { ok: false, reason: 'disabled by ENABLE_SANDBOX' };
  }
  if (!cfg.vmHost) {
    return { ok: false, reason: 'EXECUTION_VM_HOST not set' };
  }

  try {
    const result = await sshExec({
      command: 'docker --version',
      timeout_ms: 10_000,
    });
    if (result.exit_code !== 0) {
      return { ok: false, reason: `ssh exec non-zero exit (${result.exit_code})` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `ssh connection error: ${(e as Error).message}` };
  }
}

/**
 * 부팅 시 호출. 결과를 로그에 남기고, ok 여부만 반환.
 * 호출 측이 이걸로 sandbox 도구 등록 스킵 여부를 결정.
 *
 * Usage:
 *   const sandboxReady = await initSandbox();
 *   if (sandboxReady) registerSandboxMcpServer(...);
 */
export async function initSandbox(): Promise<boolean> {
  const result = await verifySandboxConnectivity();
  if (result.ok) {
    console.log(`[sandbox] enabled — execution VM = ${config.sandbox.vmHost}`);
    return true;
  }
  // ENABLE_SANDBOX=false 는 정상 비활성. 그 외는 의도치 않은 비활성이라 warn.
  if (result.reason === 'disabled by ENABLE_SANDBOX') {
    console.log('[sandbox] disabled (ENABLE_SANDBOX=false)');
  } else {
    console.warn(`[sandbox] disabled — ${result.reason}`);
  }
  return false;
}
