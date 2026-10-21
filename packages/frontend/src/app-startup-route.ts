// Match only App shell routes; standalone/link routes must not download App.
export function shouldPreloadApp(pathname: string, search: string): boolean {
  const params = new URLSearchParams(search);
  if (['passwordReset', 'accountInvitation', 'accountEmailVerification'].some((key) => params.has(key))) return false;
  return pathname === '/' || /^\/(?:s|r|rooms)\/[^/]+\/?$/.test(pathname);
}
