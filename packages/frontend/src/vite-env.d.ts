/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_TOWER_DEV_HOSTS?: string;
}

interface Window {
  __TOWER_RUNTIME_CONFIG__?: {
    defaultLanguage?: 'en' | 'ko';
  };
}
