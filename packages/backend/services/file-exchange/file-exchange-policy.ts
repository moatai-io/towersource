// Owns: source/destination policy for cross-scope delivery. Public API: decideTransferPolicy. See README.md.
import type { FileDestinationRef, FileSourceRef, FileTransferMode } from './file-exchange-types.js';
import { FileExchangeError } from './file-exchange-types.js';

export interface TransferPolicyDecision {
  mode: FileTransferMode;
  confirmationRequired: boolean;
  confirmationMessage: string | null;
}

const scopeRank = { session: 0, personal: 1, project: 2, channel: 3 } as const;

/** Decide delivery semantics without performing ACL checks. */
export function decideTransferPolicy(source: FileSourceRef, destination: FileDestinationRef): TransferPolicyDecision {
  if (source.scope === 'personal' && destination.scope === 'personal') {
    throw new FileExchangeError('INVALID', '같은 개인 자료함 안의 이동은 내 파일 화면에서 수행하세요.');
  }
  if (source.scope === 'project' && destination.scope === 'project' && source.projectId === destination.projectId) {
    throw new FileExchangeError('INVALID', '같은 AI 팀원 작업공간 안의 이동은 파일 화면에서 수행하세요.');
  }
  if (source.scope === 'channel' && destination.scope === 'channel' && source.channelId === destination.channelId) {
    throw new FileExchangeError('INVALID', '같은 채널 안의 파일 재공유는 지원하지 않습니다.');
  }

  const mode: FileTransferMode = destination.scope === 'project' ? 'workspace_copy' : 'snapshot';
  const confirmationRequired = destination.scope === 'personal'
    || destination.scope === 'channel'
    || destination.scope === 'project'
    || scopeRank[destination.scope] > scopeRank[source.scope];
  const confirmationMessage = destination.scope === 'personal'
    ? '이 파일의 독립된 사본을 내 개인 자료함에 영구 저장합니다.'
    : destination.scope === 'channel'
      ? '이 파일의 독립된 사본을 채널 구성원과 공유합니다.'
      : destination.scope === 'project'
        ? '이 파일의 독립된 사본을 AI 팀원 작업공간에 영구 저장합니다.'
        : confirmationRequired
          ? '이 파일을 더 넓은 작업 범위에 사본으로 전달합니다.'
          : null;

  return { mode, confirmationRequired, confirmationMessage };
}
