import { createHash } from 'node:crypto';

/** Inspect only Responses instructions, never conversation/tool text. No raw text leaves this function. */
export function languageRequestEvidence(rawBody: unknown) {
  if (typeof rawBody !== 'string') return { instructionsState: 'unavailable' };
  try {
    const body = JSON.parse(rawBody);
    const instructions = typeof body?.instructions === 'string' ? body.instructions : null;
    if (instructions === null) return { instructionsState: 'absent' };
    const codes = [...instructions.matchAll(/The configured response language is \*\*[^\n]*?\/ ([a-z]{2,3})\)\*\*/g)].map(match => match[1]);
    return {
      instructionsState: 'present',
      instructionsSha256: createHash('sha256').update(instructions).digest('hex'),
      languagePolicyPresent: instructions.includes('## Language Policy (HIGHEST PRIORITY)'),
      configuredLanguages: [...new Set(codes)],
      languagePolicyCount: codes.length,
      commentaryPolicyPresent: instructions.includes('This language policy applies to every user-visible assistant message'),
    };
  } catch {
    return { instructionsState: 'invalid-json' };
  }
}
