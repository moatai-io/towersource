const PROVIDER_ENV_HINTS: Array<{ pattern: RegExp; prefixes: string[] }> = [
  { pattern: /(?:^|[^a-z0-9])(openai|gpt[-_ ]?image|chatgpt)(?:[^a-z0-9]|$)/i, prefixes: ['OPENAI_'] },
  { pattern: /\b(apify)\b/i, prefixes: ['APIFY_'] },
  { pattern: /\b(firecrawl)\b/i, prefixes: ['FIRECRAWL_'] },
  { pattern: /\b(naver)\b/i, prefixes: ['NAVER_'] },
  { pattern: /\b(notion)\b/i, prefixes: ['NOTION_'] },
  { pattern: /\b(tiro)\b/i, prefixes: ['TIRO_'] },
  { pattern: /\b(frappe)\b/i, prefixes: ['FRAPPE_'] },
  { pattern: /\b(n8n)\b/i, prefixes: ['N8N_'] },
  { pattern: /\b(agent[_ -]?store)\b/i, prefixes: ['AGENT_STORE_'] },
  { pattern: /\b(higgsfield)\b/i, prefixes: ['HIGGSFIELD_'] },
];

/** Infer the narrow Credential environment scope explicitly requested by one command. */
export function requestedCredentialEnvNames(command: string): Set<string> {
  const requested = new Set<string>();
  for (const declaration of command.matchAll(/(?:^|\n)\s*#\s*tower-credentials\s*:\s*([^\n]+)/gi)) {
    for (const candidate of declaration[1].split(/[\s,]+/)) {
      const envName = candidate.trim();
      if (/^[A-Z][A-Z0-9_]{1,63}$/.test(envName)) requested.add(envName);
    }
  }
  for (const match of command.matchAll(/(?:\$\{?|process\.env\.|os\.getenv\(["'])([A-Z][A-Z0-9_]{1,63})/g)) requested.add(match[1]);
  for (const hint of PROVIDER_ENV_HINTS) if (hint.pattern.test(command)) hint.prefixes.forEach(prefix => requested.add(prefix));
  return requested;
}

export function credentialEnvRequested(envName: string, requested: ReadonlySet<string>): boolean {
  return requested.has(envName) || [...requested].some(prefix => prefix.endsWith('_') && envName.startsWith(prefix));
}
