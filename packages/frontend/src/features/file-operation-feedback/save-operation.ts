import i18n from '../../i18n';
import { saveScope, setFileOperation } from './feedback';

const pendingSaves = new Set<string>();
/** Await the actual HTTP result, serialize each path, and never replay writes. */
export async function saveFileOperation(path: string, write: () => Promise<Response>, onSaved: () => void): Promise<boolean> {
  if (pendingSaves.has(path)) return false;
  pendingSaves.add(path);
  const scope = saveScope(path);
  setFileOperation(scope, { status: 'pending', message: i18n.t('fileOperation.saving', { ns: 'common' }) });
  try {
    const response = await write();
    if (!response.ok) throw new Error('write rejected');
    onSaved();
    setFileOperation(scope, { status: 'saved', message: i18n.t('fileOperation.saved', { ns: 'common' }) });
    return true;
  } catch {
    setFileOperation(scope, { status: 'failed', message: i18n.t('fileOperation.saveFailed', { ns: 'common' }) });
    return false;
  } finally { pendingSaves.delete(path); }
}
