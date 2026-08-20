export function normalizeBaseUrl(baseUrl) {
  if (!baseUrl) throw new Error('baseUrl is required');
  return baseUrl.replace(/\/+$/, '');
}

export function buildHealthUrl(baseUrl) {
  return `${normalizeBaseUrl(baseUrl)}/api/health`;
}

export function buildWsUrl(baseUrl, token) {
  const base = normalizeBaseUrl(baseUrl);
  const wsBase = base.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  const url = new URL(`${wsBase}/ws`);
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

export function extractJwtSecret(envText) {
  for (const line of envText.split('\n')) {
    if (line.startsWith('JWT_SECRET=')) {
      return line.slice('JWT_SECRET='.length).trim();
    }
  }
  return '';
}

export function getPm2ProcessStatus(pm2List, target) {
  if (!Array.isArray(pm2List)) return null;
  const proc = pm2List.find((entry) => entry?.name === target);
  if (!proc) return null;
  return proc?.pm2_env?.status || null;
}

export function healthLooksOk(payload) {
  return !!payload && payload.status === 'ok';
}
