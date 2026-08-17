import { toastError, toastInfo, toastSuccess, toastWarning } from './toast';

export type ProductNoticeCode =
  | 'oauth.connect.failed'
  | 'sidebar.upload.failed'
  | 'sidebar.personal.rename.failed'
  | 'sidebar.personal.archive.failed'
  | 'sidebar.session.move.failed'
  | 'sidebar.file.create.failed'
  | 'sidebar.cwd.change.failed'
  | 'sidebar.project.delete.failed'
  | 'sidebar.member.remove.failed'
  | 'sidebar.file.move.failed'
  | 'runtime.load.failed'
  | 'runtime.capacity.save.failed'
  | 'runtime.logs.load.failed'
  | 'runtime.service.stop.failed'
  | 'runtime.box.stop.failed'
  | 'runtime.box.cleanup.failed';

export type ProductNoticeLevel = 'error' | 'warning' | 'info' | 'success';

export interface ProductNotice {
  code: ProductNoticeCode;
  level?: ProductNoticeLevel;
  context?: Record<string, string | number | boolean | null | undefined>;
  technicalDetail?: unknown;
}

const COPY: Record<ProductNoticeCode, string> = {
  'oauth.connect.failed': '계정 연결을 시작하지 못했어요. 잠시 후 다시 시도해 주세요.',
  'sidebar.upload.failed': '파일을 올리지 못했어요. 잠시 후 다시 시도해 주세요.',
  'sidebar.personal.rename.failed': '개인 파일 이름을 바꾸지 못했어요.',
  'sidebar.personal.archive.failed': '개인 파일을 보관하지 못했어요.',
  'sidebar.session.move.failed': '대화를 다른 프로젝트로 옮기지 못했어요.',
  'sidebar.file.create.failed': '파일이나 폴더를 만들지 못했어요.',
  'sidebar.cwd.change.failed': '작업 폴더를 변경하지 못했어요.',
  'sidebar.project.delete.failed': '프로젝트를 삭제하지 못했어요.',
  'sidebar.member.remove.failed': '프로젝트 멤버를 내보내지 못했어요.',
  'sidebar.file.move.failed': '파일이나 폴더를 옮기지 못했어요.',
  'runtime.load.failed': 'Runtime Box 상태를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.',
  'runtime.capacity.save.failed': 'Runtime Box 용량 설정을 적용하지 못했어요.',
  'runtime.logs.load.failed': '서비스 로그를 불러오지 못했어요.',
  'runtime.service.stop.failed': '서비스를 중지하지 못했어요.',
  'runtime.box.stop.failed': 'Runtime Box 실행을 중지하지 못했어요.',
  'runtime.box.cleanup.failed': 'Runtime Box 임시 상태를 정리하지 못했어요.',
};

function technicalMessage(detail: unknown): string | undefined {
  if (detail instanceof Error) return detail.message;
  if (typeof detail === 'string') return detail;
  if (detail == null) return undefined;
  try { return JSON.stringify(detail); } catch { return String(detail); }
}

/**
 * Product-facing notice boundary. User copy is selected by stable event code;
 * raw server/exception detail stays in diagnostics instead of the toast body.
 */
export function emitProductNotice(notice: ProductNotice): void {
  const message = COPY[notice.code];
  const detail = technicalMessage(notice.technicalDetail);
  if (detail) {
    console.warn('[product-notice]', {
      code: notice.code,
      context: notice.context,
      technicalDetail: detail,
    });
  }
  switch (notice.level || 'error') {
    case 'success': toastSuccess(message); break;
    case 'info': toastInfo(message); break;
    case 'warning': toastWarning(message); break;
    default: toastError(message);
  }
}
