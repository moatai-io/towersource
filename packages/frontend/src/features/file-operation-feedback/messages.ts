import i18n from '../../i18n';

export function uploadFailureMessage(fail: number, ok = 0, errors: Array<{ error?: string }> = []) {
  // Only allowlisted reason categories enter UI. Never echo provider/host detail.
  const raw = errors.map(e => e.error || '').join(' ');
  const reason = /\b(EACCES|EPERM)\b/.test(raw) ? 'permission' : /\b(ENOSPC|EDQUOT)\b/.test(raw) ? 'space' : null;
  const successPart = ok ? i18n.t('uploadNotice.successPart', { ns: 'common', ok }) : '';
  const message = i18n.t('uploadNotice.failed', { ns: 'common', successPart, fail, target: '' })
    + (reason ? ` · ${i18n.t(`uploadNotice.reason.${reason}`, { ns: 'common' })}` : '')
    + ' ' + i18n.t('fileOperation.uploadRecovery', { ns: 'common' });
  return message;
}
