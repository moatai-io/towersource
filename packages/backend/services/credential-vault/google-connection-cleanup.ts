/**
 * @deprecated Google Connection cleanup/default-policy migration was removed with
 * the simplified team-shared / Agent-dedicated Vault model.
 *
 * This type-only compatibility shim keeps the old operator preview script
 * compilable until that script is removed in its own scope. It performs no
 * cleanup and never mutates Credential data.
 */
export interface GoogleCredentialSnapshot {
  id: string;
  displayName: string;
  scope: string;
  ownerUserId: number | null;
  googleAccount: string | null;
  agentProjectId: string | null;
  enabled: boolean;
  updatedAt: string;
  policies: Array<{ projectId: string; mode: string; runtimeDefault: boolean; updatedAt: string }>;
}

export function buildGoogleConnectionCleanupPlan(_inventory: readonly GoogleCredentialSnapshot[]): never {
  throw new Error('Google Connection cleanup intents were removed from the simplified Credential Vault model');
}
