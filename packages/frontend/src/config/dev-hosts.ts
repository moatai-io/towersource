const DEFAULT_DEV_HOSTS = ['app.localhost'] as const;

function splitCsvHosts(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
}

/**
 * Dev-only public surfaces such as Voice Lab must not hard-code private hostnames.
 * Internal deployments can enable their real host with VITE_TOWER_DEV_HOSTS.
 */
export function getAllowedDevHosts(extraHosts = import.meta.env.VITE_TOWER_DEV_HOSTS): string[] {
  return Array.from(new Set([...DEFAULT_DEV_HOSTS, ...splitCsvHosts(extraHosts)]));
}

function isDefaultDevHostname(hostname: string): boolean {
  // Keep the rule generic: private deployment domains must not be hard-coded here.
  return hostname === 'app.localhost' || hostname.startsWith('desk-dev.');
}

export function isAllowedDevHost(
  hostname: string,
  options: { dev?: boolean; extraHosts?: string } = {},
): boolean {
  if (options.dev ?? import.meta.env.DEV) return true;
  return isDefaultDevHostname(hostname) || getAllowedDevHosts(options.extraHosts).includes(hostname);
}
