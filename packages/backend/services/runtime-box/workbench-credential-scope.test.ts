import { describe, expect, it } from 'vitest';
import { credentialEnvRequested, requestedCredentialEnvNames } from './workbench-credential-scope.js';

describe('Workbench command-scoped Credential env', () => {
  it('extracts explicit environment references across shell, Node, and Python', () => {
    const requested = requestedCredentialEnvNames("echo $OPENAI_API_KEY; node -e 'process.env.NAVER_CLIENT_ID'; python -c 'import os; os.getenv(\"TIRO_TOKEN\")'");
    expect([...requested]).toEqual(expect.arrayContaining(['OPENAI_API_KEY', 'NAVER_CLIENT_ID', 'TIRO_TOKEN']));
  });

  it('maps provider CLI hints to bounded prefixes', () => {
    const requested = requestedCredentialEnvNames('python create_openai_image.py && apify call actor');
    expect(credentialEnvRequested('OPENAI_API_KEY', requested)).toBe(true);
    expect(credentialEnvRequested('APIFY_TOKEN', requested)).toBe(true);
    expect(credentialEnvRequested('DATABASE_URL', requested)).toBe(false);
  });

  it('does not infer every SSH credential from a bare SSH command', () => {
    const requested = requestedCredentialEnvNames('ssh -o BatchMode=yes user@example.invalid true');
    expect(requested.size).toBe(0);
    expect(credentialEnvRequested('RESEARCH_SSH_KEY_FILE', requested)).toBe(false);
  });

  it('selects only the SSH key path explicitly referenced by the command', () => {
    const requested = requestedCredentialEnvNames('ssh -i "$RESEARCH_SSH_KEY_FILE" -o StrictHostKeyChecking=yes user@example.invalid true');
    expect(credentialEnvRequested('RESEARCH_SSH_KEY_FILE', requested)).toBe(true);
    expect(credentialEnvRequested('OTHER_SSH_KEY_FILE', requested)).toBe(false);
  });

  it('returns no Vault scope for an unrelated command', () => {
    const requested = requestedCredentialEnvNames('npm test');
    expect(requested.size).toBe(0);
    expect(credentialEnvRequested('OPENAI_API_KEY', requested)).toBe(false);
  });
});
