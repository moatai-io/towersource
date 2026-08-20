import i18n from '../i18n';
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

const NOTICE_KEYS: Record<ProductNoticeCode, string> = {
  'oauth.connect.failed': 'oauthConnectFailed',
  'sidebar.upload.failed': 'sidebarUploadFailed',
  'sidebar.personal.rename.failed': 'personalRenameFailed',
  'sidebar.personal.archive.failed': 'personalArchiveFailed',
  'sidebar.session.move.failed': 'sessionMoveFailed',
  'sidebar.file.create.failed': 'fileCreateFailed',
  'sidebar.cwd.change.failed': 'cwdChangeFailed',
  'sidebar.project.delete.failed': 'projectDeleteFailed',
  'sidebar.member.remove.failed': 'memberRemoveFailed',
  'sidebar.file.move.failed': 'fileMoveFailed',
  'runtime.load.failed': 'runtimeLoadFailed',
  'runtime.capacity.save.failed': 'runtimeCapacitySaveFailed',
  'runtime.logs.load.failed': 'runtimeLogsLoadFailed',
  'runtime.service.stop.failed': 'runtimeServiceStopFailed',
  'runtime.box.stop.failed': 'runtimeBoxStopFailed',
  'runtime.box.cleanup.failed': 'runtimeBoxCleanupFailed',
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
  const message = i18n.t(`productNotice.${NOTICE_KEYS[notice.code]}`, { ns: 'common' });
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
