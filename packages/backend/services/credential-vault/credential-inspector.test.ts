import { describe, expect, it } from 'vitest';
import { assertInspectorResultSecretFree, inspectCredentialValue } from './credential-inspector.js';

describe('credential inspector', () => {
  it('returns only bounded diagnostics for text credentials', () => {
    const result = inspectCredentialValue('  abc def  ');
    expect(result).toMatchObject({ format: 'text', valid: true, whitespace: 'outer', lengthBucket: 'short' });
    expect(JSON.stringify(result)).not.toContain('abc def');
    expect(() => assertInspectorResultSecretFree(result)).not.toThrow();
  });

  it('redacts sensitive JSON field names from structural inspection', () => {
    const result = inspectCredentialValue(JSON.stringify({ client_email: 'a@example.com', access_token: 'raw', project_id: 'p' }));
    expect(result.format).toBe('json');
    expect(result.jsonKeys).toEqual(['client_email', 'project_id']);
    expect(result.sensitiveFieldCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain('raw');
  });
});
