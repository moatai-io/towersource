import { create } from 'zustand';
import { getInitialLanguage } from '../i18n';

export interface ServerConfig {
  version: string;
  gitSha?: string;
  buildTime?: string;
  buildId?: string;
  publicUrl?: string | null;
  towerRole?: string | null;
  nodeEnv?: string | null;
  workspaceRoot: string;
  permissionMode: string;
  claudeExecutable: string;
  connectionType?: string;
  claudeEnabled?: boolean;
  piEnabled?: boolean;
  localEnabled?: boolean;
  defaults?: Record<string, string>;
  /** Internal Agent-first / AI talent team dogfood. Requires full role + explicit server opt-in. */
  agentFirstEnabled?: boolean;
  /** External Agent deployment management surface. Enabled on supported Agent-first VMs. */
  aiServicesEnabled?: boolean;
  /** Internal-only Workspace Apps / DIY ERP Connector beta. Full operator VM only by default. */
  workspaceAppsEnabled?: boolean;
  /** Selects the 업무 tab implementation while the connector pilot is dogfooded. */
  workspaceAppsMode?: 'local-metadata' | 'frappe-connector-pilot';
  /** Low-level Harness lifecycle administration. Full VM only. */
  harnessAdministrationEnabled?: boolean;
  /** Feature flag from /api/config. Default off when absent. */
  inlineEditEnabled?: boolean;
  /** Turn Rewind / immutable conversation branch. Managed self-hosted servers default off. */
  turnRewindEnabled?: boolean;
  /** Feature flag from /api/config. Default off when absent. */
  previewDirectEditEnabled?: boolean;
  /** Internal full-VM-only Beta workbench. Default off when absent. */
  betaWorkbenchEnabled?: boolean;
  /** Dev-first CAD Workbench beta surface. Default off when absent. */
  cadWorkbenchBetaEnabled?: boolean;
}

export type ThemeId = 'dark' | 'light';
export type LangId = 'en' | 'ko';
export type FontSize = 'small' | 'medium' | 'large';

interface SettingsState {
  isOpen: boolean;
  skillsBrowserOpen: boolean;
  agentsPanelOpen: boolean;
  helpOpen: boolean;
  /** Project context requested by a project-scoped surface such as Project Home. */
  capabilityProjectId: string | null;
  theme: ThemeId;
  language: LangId;
  fontSize: FontSize;
  serverConfig: ServerConfig | null;
  updateAvailable: boolean;
  latestBuildId: string | null;
  deferredUpdateRequested: boolean;
  setOpen: (open: boolean) => void;
  setSkillsBrowserOpen: (open: boolean) => void;
  setAgentsPanelOpen: (open: boolean) => void;
  setHelpOpen: (open: boolean) => void;
  setCapabilityProjectId: (projectId: string | null) => void;
  setTheme: (theme: ThemeId) => void;
  setLanguage: (lang: LangId) => void;
  setFontSize: (size: FontSize) => void;
  setServerConfig: (config: ServerConfig) => void;
  setUpdateAvailable: (available: boolean, buildId?: string | null) => void;
  setDeferredUpdateRequested: (requested: boolean) => void;
}

function readSavedTheme(): ThemeId {
  const saved = localStorage.getItem('theme');
  if (saved === 'light' || saved === 'dark') return saved;
  if (saved) {
    localStorage.setItem('theme', 'dark');
    return 'dark';
  }
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

export const useSettingsStore = create<SettingsState>((set) => ({
  isOpen: false,
  skillsBrowserOpen: false,
  agentsPanelOpen: false,
  helpOpen: false,
  capabilityProjectId: null,
  theme: readSavedTheme(),
  language: getInitialLanguage(),
  fontSize: (localStorage.getItem('tower:font-size') as FontSize) || 'medium',
  serverConfig: null,
  updateAvailable: false,
  latestBuildId: null,
  deferredUpdateRequested: false,
  setOpen: (open) => set({ isOpen: open }),
  setSkillsBrowserOpen: (open) => set({ skillsBrowserOpen: open }),
  setAgentsPanelOpen: (open) => set({ agentsPanelOpen: open }),
  setHelpOpen: (open) => set({ helpOpen: open }),
  setCapabilityProjectId: (capabilityProjectId) => set({ capabilityProjectId }),
  setTheme: (theme) => {
    localStorage.setItem('theme', theme);
    set({ theme });
  },
  setLanguage: (language) => {
    localStorage.setItem('tower:lang', language);
    // i18n.changeLanguage is called from the component side
    set({ language });
  },
  setFontSize: (fontSize) => {
    localStorage.setItem('tower:font-size', fontSize);
    set({ fontSize });
  },
  setServerConfig: (config) => set({ serverConfig: config }),
  setUpdateAvailable: (available, buildId = null) => set((s) => ({
    updateAvailable: available,
    latestBuildId: buildId,
    deferredUpdateRequested: available ? s.deferredUpdateRequested : false,
  })),
  setDeferredUpdateRequested: (requested) => set({ deferredUpdateRequested: requested }),
}));
