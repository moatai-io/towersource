/** Non-secret, operator-owned baseline settings only; never inherit the full Worker environment. */
export function inheritWorkerCommandEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {};
  for (const key of [
    'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'TZ', 'TMPDIR',
    'NODE_PATH', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'NIX_SSL_CERT_FILE',
  ] as const) {
    if (env[key]) inherited[key] = env[key];
  }
  return inherited;
}
