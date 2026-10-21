import type { ResourceLanguage } from 'i18next';

export const localeNamespaces = [
  'common',
  'auth',
  'layout',
  'chat',
  'admin',
  'rooms',
  'settings',
  'help',
  'git',
  'share',
  'schedule',
  'automation',
  'skills',
  'files',
  'onboarding',
] as const;

export type LocaleNamespace = typeof localeNamespaces[number];
export type SupportedLocale = 'en' | 'ko';

const loaders: Record<SupportedLocale, () => Promise<{ default: ResourceLanguage }>> = {
  en: () => import('./en'),
  ko: () => import('./ko'),
};

export async function loadLocaleResources(language: SupportedLocale): Promise<ResourceLanguage> {
  return (await loaders[language]()).default;
}
