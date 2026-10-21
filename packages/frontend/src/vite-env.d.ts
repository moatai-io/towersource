/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare const __TOWER_FRONTEND_SOURCE_REV__: string;

interface ImportMetaEnv {
  readonly VITE_TOWER_DEV_HOSTS?: string;
}

interface Window {
  __TOWER_RUNTIME_CONFIG__?: {
    defaultLanguage?: 'en' | 'ko';
  };
}
