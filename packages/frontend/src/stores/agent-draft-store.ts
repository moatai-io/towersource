import { create } from 'zustand';

export interface AgentDraftArtifact {
  status: 'draft';
  templateId?: string;
  /** Server-owned teammate-creation approval context (stable legacy system_key). */
  sourceProjectId?: string;
  face: string;
  name: string;
  levelTitle: string;
  role: string;
  /** 사용자가 이 동료에게 기대하는 전문성. bootstrap 생성의 최소 역할 입력이다. */
  expectedExpertise?: string;
  capabilities: string[];
  sourceHints: string[];
  firstTask: string;
  promotionGoal: string;
  assumptions: string[];
  tagline?: string;
  promise?: string;
  responsibilities?: string[];
  strengths?: string[];
  firstMission?: string;
  needsFromUser?: string[];
  worksFor?: string;
  accountableOutcome?: string;
  autonomousActions?: string[];
  approvalRequiredActions?: string[];
  onboardingChecks?: string[];
  capabilityRequirements?: {
    required: string[];
    optional?: string[];
    forbidden?: string[];
    dataSources?: string[];
    externalActions?: string[];
    approvalConditions?: string[];
  };
  authorityPolicy?: Record<string, unknown>;
  toolPolicy?: Record<string, unknown>;
}

interface AgentDraftState {
  currentDraft: AgentDraftArtifact | null;
  setDraft: (draft: AgentDraftArtifact | null) => void;
  updateDraft: (patch: Partial<AgentDraftArtifact>) => void;
  setFace: (face: string) => void;
}

export const useAgentDraftStore = create<AgentDraftState>((set) => ({
  currentDraft: null,
  setDraft: (draft) => set({ currentDraft: draft }),
  updateDraft: (patch) => set((state) => state.currentDraft ? { currentDraft: { ...state.currentDraft, ...patch } } : {}),
  setFace: (face) => set((state) => state.currentDraft ? { currentDraft: { ...state.currentDraft, face } } : {}),
}));
