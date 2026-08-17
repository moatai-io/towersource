import { describe, expect, it } from 'vitest';
import { classifyHiggsfieldCliStatus, higgsfieldProbePolicy } from './higgsfield-adapter.js';

describe('higgsfieldProbePolicy', () => {
  it('allows only the documented read-only CLI account status command', () => {
    expect(higgsfieldProbePolicy('cli_oauth')).toEqual({
      supported: true,
      command: ['higgsfield', 'account', 'status', '--json', '--no-color'],
      reasonCode: 'SafeReadOnlyCliStatus',
      storesProviderBody: false,
    });
  });

  it('fails safe for Cloud API credentials without a documented auth-only endpoint', () => {
    expect(higgsfieldProbePolicy('cloud_api')).toEqual({
      supported: false,
      command: null,
      reasonCode: 'NoDocumentedSafeProbe',
      storesProviderBody: false,
    });
  });
});

describe('classifyHiggsfieldCliStatus', () => {
  it.each(['Not authenticated', 'Session expired', '401 Unauthorized'])('requires reauth for %s without returning raw output', message => {
    expect(classifyHiggsfieldCliStatus({ exitCode: 1, stderr: message })).toEqual({
      status: 'reauth_required',
      reasonCode: 'ReauthRequired',
    });
  });

  it('accepts a successful read-only account status response', () => {
    expect(classifyHiggsfieldCliStatus({ exitCode: 0, stdout: '{"email":"redacted@example.com"}' })).toEqual({
      status: 'ready',
      reasonCode: 'Ready',
    });
  });

  it('classifies timeout and unknown failures as degraded', () => {
    expect(classifyHiggsfieldCliStatus({ exitCode: null, timedOut: true })).toEqual({
      status: 'degraded',
      reasonCode: 'ProviderUnavailable',
    });
    expect(classifyHiggsfieldCliStatus({ exitCode: 2, stderr: 'unexpected failure' })).toEqual({
      status: 'degraded',
      reasonCode: 'ProviderUnavailable',
    });
  });
});
