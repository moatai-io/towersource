import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const settings = fs.readFileSync(path.resolve(import.meta.dirname, './SettingsPanel.tsx'), 'utf8');
const selfModals = fs.readFileSync(path.resolve(import.meta.dirname, '../auth/UserSelfModals.tsx'), 'utf8');
const notifications = fs.readFileSync(path.resolve(import.meta.dirname, '../notifications/NotificationSettingsPanel.tsx'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../locales/en/settings.json'), 'utf8'));
const ko = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../locales/ko/settings.json'), 'utf8'));

function leafPaths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key));
}

describe('My Settings locale contract', () => {
  it('localizes settings, notification controls, and self-service account modals', () => {
    expect(settings).toContain("useTranslation('settings')");
    expect(settings).toContain("aria-label={t('common:close')}");
    expect(notifications).toContain("useTranslation('settings')");
    expect(selfModals).toContain("t('profileSaved')");
    expect(selfModals).toContain("t('common:processing')");
    expect(selfModals).not.toContain('defaultValue:');
  });

  it('ships matching English and Korean settings keys', () => {
    expect(leafPaths(en).sort()).toEqual(leafPaths(ko).sort());
  });
});
