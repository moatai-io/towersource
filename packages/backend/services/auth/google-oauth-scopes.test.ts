import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', () => ({
  config: {
    googleClientId: 'test-client',
    googleClientSecret: 'test-secret',
    googleRedirectUri: 'https://tower.example.com/api/auth/google/callback',
  },
}));

import { GOOGLE_DEFAULT_SCOPES, getGoogleAuthUrl } from './google-oauth.js';

describe('Google Sheets editing OAuth consent', () => {
  it('requests Sheets editing without broadening Drive, Calendar, or Docs access', () => {
    expect(GOOGLE_DEFAULT_SCOPES).toEqual([
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ]);
  });

  it('includes editing scope and explicit offline consent in the actual authorization URL', () => {
    const url = new URL(getGoogleAuthUrl('test-opaque-state'));
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(GOOGLE_DEFAULT_SCOPES);
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('state')).toBe('test-opaque-state');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('https://tower.example.com/api/auth/google/callback');
    expect(url.searchParams.has('client_secret')).toBe(false);
  });
});
