import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { loadLocaleResources, localeNamespaces, type SupportedLocale } from './locales/load-resources';

export const defaultNS = 'common';
export type SupportedLanguage = SupportedLocale;

function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return value === 'en' || value === 'ko';
}

/**
 * Language priority: explicit user choice → VM runtime default → Korean default.
 * Set TOWER_DEFAULT_LANGUAGE=en to opt into English without changing the build.
 */
export function resolveInitialLanguage(saved: unknown, configured: unknown): SupportedLanguage {
  if (isSupportedLanguage(saved)) return saved;
  return isSupportedLanguage(configured) ? configured : 'ko';
}

export function getInitialLanguage(): SupportedLanguage {
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('tower:lang') : null;
  const configured = typeof window !== 'undefined'
    ? window.__TOWER_RUNTIME_CONFIG__?.defaultLanguage
    : undefined;
  return resolveInitialLanguage(saved, configured);
}

const initialLanguage = getInitialLanguage();
const loadedLanguages = new Set<SupportedLanguage>();

async function ensureLanguageResources(language: SupportedLanguage): Promise<void> {
  if (loadedLanguages.has(language)) return;
  const resources = await loadLocaleResources(language);
  for (const namespace of localeNamespaces) {
    i18n.addResourceBundle(language, namespace, resources[namespace] ?? {}, true, true);
  }
  loadedLanguages.add(language);
}

// Do not block the entry module: main starts the default route download while
// the active language loads, then waits for this promise before rendering.
export const i18nReady = i18n.use(initReactI18next).init({
  lng: initialLanguage,
  fallbackLng: false,
  defaultNS,
  ns: [...localeNamespaces],
  resources: {},
  interpolation: {
    escapeValue: false, // React already escapes
  },
}).then(() => ensureLanguageResources(initialLanguage));

const baseChangeLanguage = i18n.changeLanguage.bind(i18n);
i18n.changeLanguage = (async (language?: string, callback?: (error: Error | null, t: typeof i18n.t) => void) => {
  if (isSupportedLanguage(language)) await ensureLanguageResources(language);
  return baseChangeLanguage(language, callback);
}) as typeof i18n.changeLanguage;

// Sync language changes to localStorage
i18n.on('languageChanged', (lng) => {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('tower:lang', lng);
  }
});

export default i18n;
