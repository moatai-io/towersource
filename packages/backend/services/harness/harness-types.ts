/**
 * Owns: engine-neutral Agent Harness runtime types.
 * Public API: ResolvedHarness, HarnessResolutionInput, HarnessRuntimeFingerprint.
 * See README.md.
 */

export type HarnessEngine = 'pi' | 'claude';
export type HarnessResolutionSource = 'legacy-default' | 'database' | 'session-snapshot';

export interface PromptComponentReference {
  id: string;
  version: number;
}

export interface HarnessPromptPlan {
  includePlatformKernel: true;
  includeAgentIdentity: boolean;
  includeProjectInstructions: boolean;
  includeMemory: boolean;
  includeSkills: boolean;
  /** Legacy schema-v1 compatibility projection of components. */
  fragments: string[];
  /** Immutable Prompt Component references used by new Harness versions. */
  components?: PromptComponentReference[];
  /** Stable identity of Platform Kernel + context slots + component versions. */
  bundleHash?: string;
}

export interface ResolvedHarness {
  id: string;
  version: number;
  runtimeProfileId: string;
  runtimeProfileVersion: number;
  engine: HarnessEngine;
  defaultModel: string | null;
  allowedModels: string[] | null;
  prompt: HarnessPromptPlan;
  capabilityIds: readonly string[];
  /** Legacy snapshot metadata only. Runtime isolation is capability/Runtime Box policy, not a Harness mode. */
  sandboxMode?: 'platform-default' | 'host' | 'runtime-box' | 'none';
  /** Legacy snapshot metadata only. Network authority comes from registered capabilities/providers. */
  networkMode?: 'platform-default' | 'none' | 'allowlist';
  source: HarnessResolutionSource;
}

export type HarnessInvocationKind = 'session' | 'channel' | 'quick-reply' | 'task' | 'proactive' | 'worker';

export interface ChannelInvocationContext {
  channelId: string;
  threadId?: string;
  agentProjectId: string;
  invokingUserId: number;
  audienceUserIds: number[];
  linkedResources: Array<{
    type: 'project';
    id: string;
    capability: 'discover' | 'read' | 'write';
  }>;
}

export interface HarnessResolutionInput {
  sessionId: string;
  projectId?: string;
  requestedEngine: HarnessEngine;
  requestedModel?: string;
  requestedHarnessId?: string;
  requestedHarnessVersion?: number;
  requestedRuntimeProfileId?: string;
  requestedRuntimeProfileVersion?: number;
  invocationKind?: HarnessInvocationKind;
  channel?: ChannelInvocationContext;
}

export interface HarnessRuntimeFingerprint {
  harnessId: string;
  harnessVersion: number;
  runtimeProfileId: string;
  runtimeProfileVersion: number;
  engine: HarnessEngine;
  resolutionSource: HarnessResolutionSource;
  promptBundleHash: string;
  toolSetHash: string;
  toolCount: number;
}
