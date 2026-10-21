import { uploadFailureMessage } from './messages';
import { create } from 'zustand';
import i18n from '../../i18n';

export interface FileOperationNotice { message: string; status: 'failed' | 'pending' | 'saved' }
export const useFileOperationFeedback = create<{ notices: Record<string, FileOperationNotice> }>(() => ({ notices: {} }));
export const saveScope = (path: string) => `save:${path}`;
export const uploadScope = (surface: string, owner = '') => `upload:${surface}:${owner}`;

export function clearFileOperation(scope: string) {
  useFileOperationFeedback.setState(s => {
    const notices = { ...s.notices };
    delete notices[scope];
    return { notices };
  });
}
export function setFileOperation(scope: string, notice: FileOperationNotice) {
  useFileOperationFeedback.setState(s => ({ notices: { ...s.notices, [scope]: notice } }));
}
export function reportUploadFailure(scope: string, fail: number, ok = 0, errors: Array<{ error?: string }> = []) {
  setFileOperation(scope, { status: 'failed', message: uploadFailureMessage(fail, ok, errors) });
}

/** Transport/read failures have unknown outcomes, not an invented failure count. */
export function reportUploadUnknown(scope: string) {
  setFileOperation(scope, { status: 'failed', message: i18n.t('fileOperation.uploadUnknown', { ns: 'common' }) });
}
