import { getOrCreateBox, execInBox } from '../../runtime-box/runtime-box-manager.js';
import type { ProviderHealthStatus } from '../connection-read-model.js';

export type ConnectionProbeDepth = 'provider_read_only' | 'materialization_only' | 'unsupported';

export interface ConnectionProbeResult {
  connectionId: string;
  projectId: string;
  checkedAt: string;
  depth: ConnectionProbeDepth;
  materialization: {
    status: 'verified' | 'failed' | 'unknown';
    reasonCode: 'RuntimeCredentialInjected' | 'RuntimeCredentialUnavailable' | 'ProbeUnsupported';
  };
  providerHealth: {
    status: ProviderHealthStatus;
    reasonCode: 'Ready' | 'ReauthRequired' | 'ReadOnlyProbeFailed' | 'ProbeUnsupported';
  };
  checks: Array<{
    id: 'runtime_materialization' | 'provider_auth' | 'read_only_api';
    status: 'pass' | 'fail' | 'unknown';
    label: string;
  }>;
}

interface ProbeConnection {
  id: string;
  source: 'credential' | 'profile';
  provider: string | null;
  connectionType: string | null;
}

function unsupported(input: { connection: ProbeConnection; projectId: string }): ConnectionProbeResult {
  return {
    connectionId: `${input.connection.source}:${input.connection.id}`,
    projectId: input.projectId,
    checkedAt: new Date().toISOString(),
    depth: 'unsupported',
    materialization: { status: 'unknown', reasonCode: 'ProbeUnsupported' },
    providerHealth: { status: 'unsupported', reasonCode: 'ProbeUnsupported' },
    checks: [
      { id: 'runtime_materialization', status: 'unknown', label: '이 Connection 유형의 자동 Runtime 검사를 아직 지원하지 않습니다.' },
      { id: 'provider_auth', status: 'unknown', label: '안전한 비과금 Provider probe가 등록되지 않았습니다.' },
    ],
  };
}

function classifyGwsOutput(input: { connectionId: string; projectId: string; stdout: string; exitCode: number }): ConnectionProbeResult {
  const authMatch = input.stdout.match(/TOWER_GWS_AUTH=(\d+)/);
  const readMatch = input.stdout.match(/TOWER_GWS_READ=(\d+)/);
  const authExit = authMatch ? Number(authMatch[1]) : null;
  const readExit = readMatch ? Number(readMatch[1]) : null;
  const materialized = authExit !== null;
  const authReady = authExit === 0;
  const readReady = readExit === 0;
  return {
    connectionId: input.connectionId,
    projectId: input.projectId,
    checkedAt: new Date().toISOString(),
    depth: 'provider_read_only',
    materialization: materialized
      ? { status: 'verified', reasonCode: 'RuntimeCredentialInjected' }
      : { status: 'failed', reasonCode: 'RuntimeCredentialUnavailable' },
    providerHealth: !materialized
      ? { status: 'unknown', reasonCode: 'ReadOnlyProbeFailed' }
      : !authReady
        ? { status: 'reauth_required', reasonCode: 'ReauthRequired' }
        : readReady
          ? { status: 'ready', reasonCode: 'Ready' }
          : { status: 'degraded', reasonCode: 'ReadOnlyProbeFailed' },
    checks: [
      { id: 'runtime_materialization', status: materialized ? 'pass' : 'fail', label: materialized ? '선택한 Credential이 Runtime 명령에 주입됐습니다.' : 'Runtime에서 선택한 Credential을 사용할 수 없습니다.' },
      { id: 'provider_auth', status: authReady ? 'pass' : materialized ? 'fail' : 'unknown', label: authReady ? 'Google 인증 상태가 유효합니다.' : materialized ? 'Google 인증이 유효하지 않습니다.' : 'Runtime 주입 실패로 인증을 확인하지 못했습니다.' },
      { id: 'read_only_api', status: readReady ? 'pass' : authReady ? 'fail' : 'unknown', label: readReady ? 'Gmail 최소 read-only API 호출에 성공했습니다.' : authReady ? 'Google 인증은 확인됐지만 Gmail read-only 호출에 실패했습니다.' : 'Google 인증 실패로 read-only API를 확인하지 못했습니다.' },
    ],
  };
}

/** Execute a secret-safe, read-only health probe for one exact Connection. */
export async function probeConnection(input: {
  connection: ProbeConnection;
  projectId: string;
  userId: number;
}): Promise<ConnectionProbeResult> {
  const fullConnectionId = `${input.connection.source}:${input.connection.id}`;
  const isGws = input.connection.source === 'credential'
    && input.connection.provider === 'google'
    && input.connection.connectionType === 'gws';
  if (!isGws) return unsupported(input);
  if (!/^[A-Za-z0-9._-]+$/.test(input.connection.id)) return unsupported(input);

  const box = await getOrCreateBox(input.projectId, input.userId);
  const command = [
    'set +e',
    `GWS_CONNECTION_ID='${input.connection.id}' gws auth status >/dev/null 2>&1`,
    'auth_exit=$?',
    `GWS_CONNECTION_ID='${input.connection.id}' gws gmail users getProfile --params '{"userId":"me"}' >/dev/null 2>&1`,
    'read_exit=$?',
    `printf 'TOWER_GWS_AUTH=%s\\nTOWER_GWS_READ=%s\\n' "$auth_exit" "$read_exit"`,
  ].join('\n');
  const result = await execInBox({
    boxId: Number(box.id),
    userId: input.userId,
    cmd: command,
    cwd: '/workspace',
    timeout_sec: 30,
  });
  return classifyGwsOutput({
    connectionId: fullConnectionId,
    projectId: input.projectId,
    stdout: result.stdout,
    exitCode: result.exit_code,
  });
}
