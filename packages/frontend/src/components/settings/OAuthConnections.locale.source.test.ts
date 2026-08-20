import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './OAuthConnections.tsx'), 'utf8');

function locale(lang: 'en' | 'ko') {
  return JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, `../../locales/${lang}/settings.json`), 'utf8'));
}

describe('OAuthConnections locale contract', () => {
  it('routes account actions and skill readiness through settings locale keys', () => {
    for (const key of [
      'oauthConnections.title',
      'oauthConnections.connect',
      'oauthConnections.disconnectTitle',
      'oauthConnections.skillReadiness',
      'oauthConnections.readyCount',
      'oauthConnections.noCredentialSkills',
      'oauthConnections.missingConnections',
    ]) expect(source).toContain(key);
  });

  it('keeps the English and Korean locale structures aligned', () => {
    expect(Object.keys(locale('en').oauthConnections).sort()).toEqual(Object.keys(locale('ko').oauthConnections).sort());
  });
});
