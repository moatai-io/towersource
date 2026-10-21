export type DeployStage = 'source' | 'detect' | 'prepare' | 'copy' | 'provider' | 'manifest' | 'gateway';

const messages: Record<DeployStage, string> = {
  source: '발행할 소스 디렉터리를 확인할 수 없습니다. 파일과 접근 권한을 확인해 주세요.',
  detect: '발행 대상의 형식을 확인하지 못했습니다. 소스 파일을 확인해 주세요.',
  prepare: '발행 경로를 준비하지 못했습니다. 운영자에게 저장소 상태 확인을 요청해 주세요.',
  copy: '게시 파일 복사에 실패했습니다. 기존 게시물 상태를 확인한 뒤 다시 시도해 주세요.',
  provider: '배포 서비스에서 발행을 완료하지 못했습니다. 운영자에게 연결 상태 확인을 요청해 주세요.',
  manifest: '게시 파일 처리 후 발행 목록 저장에 실패했습니다. 재발행 전에 게시물 상태를 확인해 주세요.',
  gateway: '발행 게이트웨이 요청을 완료하지 못했습니다. 게시 상태를 확인한 뒤 다시 시도해 주세요.',
};

export class DeployError extends Error {
  readonly code: string;
  readonly recoverable = true;
  readonly retrySafe = false;
  constructor(readonly stage: DeployStage, cause: unknown) {
    super(messages[stage], { cause });
    this.name = 'DeployError';
    this.code = `PUBLISH_${stage.toUpperCase()}_FAILED`;
  }
}

export async function atDeployStage<T>(stage: DeployStage, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) { throw error instanceof DeployError ? error : new DeployError(stage, error); }
}

/** Public diagnostics deliberately exclude raw exceptions, paths and provider output. */
export function deployErrorResponse(error: unknown) {
  if (error instanceof DeployError) {
    return { error: error.message, code: error.code, stage: error.stage,
      recoverable: error.recoverable, retrySafe: error.retrySafe };
  }
  return { error: '발행 요청을 완료하지 못했습니다. 운영자에게 확인을 요청해 주세요.',
    code: 'PUBLISH_FAILED', stage: 'unknown', recoverable: false, retrySafe: false };
}
