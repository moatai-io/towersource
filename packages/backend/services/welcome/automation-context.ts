/** Conservative minimization before automated instructions become model reference data. */
export function safeAutomationContext(value: unknown, limit = 600): string {
  if (typeof value !== 'string') return '';
  // Omit the entire field on common secret/contact signals; do not send a partly redacted instruction.
  if (/(?:password|passwd|secret|token|api[_ -]?key|authorization|bearer|private key|비밀번호|비밀키|주민등록|계좌번호)|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|https?:\/\/\S+[?@]|\b(?:sk|ghp|xoxb)-[\w-]+/i.test(value)) return '';
  return value.replace(/https?:\/\/\S+/g, '(link omitted)').replace(/[\x00-\x1f\x7f<>`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}
