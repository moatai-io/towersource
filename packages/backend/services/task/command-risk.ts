/**
 * Owns: conservative command risk classification for scheduled shell/script jobs.
 * Public API: classifyCommandRisk(). See README.md.
 */
export type CommandRiskLevel = 'low' | 'medium' | 'high';

const HIGH_RISK_PATTERNS = [
  /\brm\s+-[^\n;|&]*r[^\n;|&]*f\b/,
  /\bsudo\b/,
  /docker\s+.*(--privileged|\/var\/run\/docker\.sock)/,
  /\bpm2\s+(restart|delete|stop|kill)\b/,
  /\bgit\s+push\b/,
  /\bgit\s+.*--force\b/,
  /\bssh\b/,
  /\bscp\b/,
  /\bcurl\b.*\|\s*(sh|bash)/,
  /\bwget\b.*\|\s*(sh|bash)/,
  />\s*\/etc\//,
  /\bchmod\s+777\b/,
];

const LOW_RISK_PATTERNS = [
  /^\s*echo\s+[^;&|]+\s*$/,
  /^\s*pwd\s*$/,
  /^\s*date\s*$/,
  /^\s*ls(\s+[-\w./]+)*\s*$/,
];

export function classifyCommandRisk(command: string): CommandRiskLevel {
  const normalized = command.trim();
  if (!normalized) return 'medium';
  if (HIGH_RISK_PATTERNS.some((re) => re.test(normalized))) return 'high';
  if (LOW_RISK_PATTERNS.some((re) => re.test(normalized))) return 'low';
  return 'medium';
}
