/** An epoch identifies the credential used by an async operation, not an authorization grant. */
export function isCurrentCredential(expected: string | null, storage: Pick<Storage, 'getItem'> = localStorage): boolean {
  return storage.getItem('token') === expected;
}

/** Old responses must never clear a newer login. */
export function clearCredentialIfCurrent(expected: string, storage: Pick<Storage, 'getItem' | 'removeItem'> = localStorage): boolean {
  if (!isCurrentCredential(expected, storage)) return false;
  for (const key of ['token', 'userId', 'username', 'userRole']) storage.removeItem(key);
  return true;
}

/** Rebuild module-level stores under the new identity instead of hot-swapping them. */
export function restartAccountShell(): void {
  window.location.replace('/');
}
