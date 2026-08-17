const SENSITIVE_KEY_RE = /(secret|token|password|private|credential|authorization|cookie)/i;

export interface CredentialInspectionResult {
  format: 'text' | 'json';
  valid: boolean;
  lengthBucket: 'empty' | 'short' | 'medium' | 'long';
  whitespace: 'none' | 'outer' | 'embedded';
  jsonKeys?: string[];
  sensitiveFieldCount?: number;
}

function lengthBucket(value: string): CredentialInspectionResult['lengthBucket'] {
  if (!value.length) return 'empty';
  if (value.length < 16) return 'short';
  if (value.length < 128) return 'medium';
  return 'long';
}

export function inspectCredentialValue(value: string): CredentialInspectionResult {
  const trimmed = value.trim();
  const whitespace = value !== trimmed ? 'outer' : /\s/.test(value) ? 'embedded' : 'none';
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    const keys = Object.keys(parsed).sort();
    return {
      format: 'json',
      valid: true,
      lengthBucket: lengthBucket(value),
      whitespace,
      jsonKeys: keys.filter(key => !SENSITIVE_KEY_RE.test(key)),
      sensitiveFieldCount: keys.filter(key => SENSITIVE_KEY_RE.test(key)).length,
    };
  } catch {
    return {
      format: 'text',
      valid: trimmed.length > 0,
      lengthBucket: lengthBucket(value),
      whitespace,
    };
  }
}

export function assertInspectorResultSecretFree(result: CredentialInspectionResult): void {
  const serialized = JSON.stringify(result);
  if (/"(?:secret|token|password|privateKey|value)"\s*:/i.test(serialized)) {
    throw new Error('INSPECTOR_RESULT_NOT_SECRET_FREE');
  }
}
