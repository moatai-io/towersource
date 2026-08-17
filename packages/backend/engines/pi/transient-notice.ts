// Owns stable terminal transport-failure notices and deduplicated content appends.
// Public API: terminal notice constants, makeTransientNoticeBlock, appendTransientNoticeIfMissing.

import type { TowerContentBlock } from '../types.js';

export const TRANSIENT_ABORT_EXHAUSTED_NOTICE_TEXT = '응답을 생성하는 도중 외부 서비스와의 연결이 반복해서 끊겼습니다. 입력하신 내용의 문제는 아니며, 다시 시도하면 대부분 정상 처리됩니다. 같은 문제가 자주 반복되면 “이슈로 등록해”라고 입력해 주세요.';
export const PROVIDER_CAPACITY_EXHAUSTED_NOTICE_TEXT = '응답을 생성하는 외부 서비스가 계속 불안정해 이번 응답을 이어가지 못했습니다. 입력하신 내용의 문제는 아니며, 다시 시도하면 대부분 정상 처리됩니다. 같은 문제가 자주 반복되면 “이슈로 등록해”라고 입력해 주세요.';

export function makeTransientNoticeBlock(text: string): TowerContentBlock {
  return {
    type: 'text',
    text,
  };
}

export function appendTransientNoticeIfMissing(
  currentContent: TowerContentBlock[],
  noticeBlock: TowerContentBlock,
): { content: TowerContentBlock[]; appended: boolean } {
  const noticeText = noticeBlock.type === 'text' ? noticeBlock.text : '';
  const hasNotice = currentContent.some(
    (block) => block.type === 'text' && block.text === noticeText,
  );
  if (hasNotice) return { content: currentContent, appended: false };
  return { content: [...currentContent, noticeBlock], appended: true };
}
