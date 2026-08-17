import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets } from './prompt-inspector.js';

const source = fs.readFileSync(path.resolve(import.meta.dirname, 'prompt-inspector.ts'), 'utf8');

describe('prompt inspector safety contract', () => {
  it('redacts secret-shaped values and never logs prompt content', () => {
    expect(source).toContain('redactSecrets');
    expect(source).toContain("'$1[REDACTED]'");
    const auditLine = source.split('\n').find((line) => line.includes('console.info')) || '';
    expect(auditLine).not.toContain('${content}');
    expect(auditLine).not.toContain('item.content');
  });

  it('redacts quoted env, JSON, bearer, and multiline private-key values', () => {
    const privateKey = ['-----BEGIN ' + 'PRIVATE KEY-----', 'abc123', 'def456', '-----END ' + 'PRIVATE KEY-----'].join('\n');
    const output = redactSecrets([
      'TOKEN="quotedsecret"',
      '{"token":"jsonsecret"}',
      "password: 'hunter2'",
      'Authorization: Bearer bearer-secret-value',
      privateKey,
    ].join('\n'));

    expect(output).not.toContain('quotedsecret');
    expect(output).not.toContain('jsonsecret');
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain('bearer-secret-value');
    expect(output).not.toContain('abc123');
    expect(output).toMatch(/TOKEN=(?:"\[REDACTED\]"|\[REDACTED\])/);
    expect(output).toContain('{"token":"[REDACTED]"}');
    expect(output).toContain('[REDACTED PRIVATE KEY]');
  });

  it('uses Pi resource loader reconstruction', () => {
    expect(source).toContain('buildPiSessionResources');
    expect(source).toContain('getSystemPrompt');
  });
});
