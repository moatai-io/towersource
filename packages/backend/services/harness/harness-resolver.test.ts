import { describe, expect, it } from 'vitest';
import { buildHarnessRuntimeFingerprint } from './harness-fingerprint.js';
import { resolveHarnessForSession } from './harness-resolver.js';

describe('Agent Harness core contract', () => {
  it('resolves existing Pi sessions to immutable tower-default@v1', async () => {
    const harness = await resolveHarnessForSession({
      sessionId: 'session-1',
      projectId: 'project-1',
      requestedEngine: 'pi',
      requestedModel: 'litellm-responses/smartest',
    });

    expect(harness).toMatchObject({
      id: 'tower-default',
      version: 1,
      runtimeProfileId: 'standard',
      runtimeProfileVersion: 1,
      engine: 'pi',
      source: 'legacy-default',
    });
    expect(harness.prompt).toMatchObject({
      includeAgentIdentity: false,
      includeProjectInstructions: true,
      includeMemory: true,
      includeSkills: true,
    });
    expect(Object.isFrozen(harness)).toBe(true);
  });

  it('rejects cross-engine resolution instead of silently falling back', async () => {
    await expect(resolveHarnessForSession({
      sessionId: 'session-1',
      requestedEngine: 'claude',
    })).rejects.toThrow('does not support engine claude');
  });

  it('resolves quick-web-research with the smart model and a two-capability allowlist', async () => {
    const harness = await resolveHarnessForSession({
      sessionId: 'research-session-1',
      projectId: 'research-agent',
      requestedEngine: 'pi',
      requestedHarnessId: 'quick-web-research',
    });

    expect(harness).toMatchObject({
      id: 'quick-web-research',
      version: 1,
      defaultModel: 'litellm-responses/smart',
      allowedModels: ['litellm-responses/smart'],
      capabilityIds: ['web.fetch', 'web.search'],
      sandboxMode: 'none',
    });
    expect(harness.prompt).toMatchObject({ includeMemory: false, includeSkills: false, includeProjectInstructions: false });
  });

  it('rejects unknown Harness ids and disallowed models', async () => {
    await expect(resolveHarnessForSession({
      sessionId: 'research-session-1',
      requestedEngine: 'pi',
      requestedHarnessId: 'unknown-harness',
    })).rejects.toThrow('Unknown Harness');

    await expect(resolveHarnessForSession({
      sessionId: 'research-session-1',
      requestedEngine: 'pi',
      requestedHarnessId: 'quick-web-research',
      requestedModel: 'litellm-responses/smartest',
    })).rejects.toThrow('does not allow model');
  });

  it('requires complete caller and Agent context for channel resolution', async () => {
    await expect(resolveHarnessForSession({
      sessionId: 'channel-session-1',
      projectId: 'agent-project-1',
      requestedEngine: 'pi',
      invocationKind: 'channel',
    })).rejects.toThrow('requires invocation context');

    await expect(resolveHarnessForSession({
      sessionId: 'channel-session-1',
      projectId: 'agent-project-1',
      requestedEngine: 'pi',
      invocationKind: 'channel',
      channel: {
        channelId: 'channel-1',
        agentProjectId: 'agent-project-1',
        invokingUserId: 0,
        audienceUserIds: [1, 2],
        linkedResources: [],
      },
    })).rejects.toThrow('requires an invoking user');
  });

  it('does not allow channel context to select a different Agent binding', async () => {
    await expect(resolveHarnessForSession({
      sessionId: 'channel-session-1',
      projectId: 'agent-project-1',
      requestedEngine: 'pi',
      invocationKind: 'channel',
      channel: {
        channelId: 'channel-1',
        agentProjectId: 'other-agent-project',
        invokingUserId: 1,
        audienceUserIds: [1, 2],
        linkedResources: [],
      },
    })).rejects.toThrow('does not match');
  });

  it('resolves quick-web-research with Smart as its only model and web-only capabilities', async () => {
    const harness = await resolveHarnessForSession({
      sessionId: 'research-session-1',
      projectId: 'research-agent-project',
      requestedEngine: 'pi',
      requestedHarnessId: 'quick-web-research',
    });

    expect(harness).toMatchObject({
      id: 'quick-web-research',
      version: 1,
      defaultModel: 'litellm-responses/smart',
      allowedModels: ['litellm-responses/smart'],
      capabilityIds: ['web.fetch', 'web.search'],
      sandboxMode: 'none',
    });
  });

  it('rejects unknown Harness ids and disallowed models', async () => {
    await expect(resolveHarnessForSession({
      sessionId: 'research-session-1',
      requestedEngine: 'pi',
      requestedHarnessId: 'missing-harness',
    })).rejects.toThrow('Unknown Harness');

    await expect(resolveHarnessForSession({
      sessionId: 'research-session-1',
      requestedEngine: 'pi',
      requestedHarnessId: 'quick-web-research',
      requestedModel: 'litellm-responses/smartest',
    })).rejects.toThrow('does not allow model');
  });

  it('fingerprints a tool set independent of ordering and duplicates', async () => {
    const harness = await resolveHarnessForSession({ sessionId: 'session-1', requestedEngine: 'pi' });
    const first = buildHarnessRuntimeFingerprint(harness, ['write', 'read', 'read']);
    const second = buildHarnessRuntimeFingerprint(harness, ['read', 'write']);

    expect(first.toolSetHash).toBe(second.toolSetHash);
    expect(first.promptBundleHash).toBe(second.promptBundleHash);
    expect(first.promptBundleHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.toolCount).toBe(2);
    expect(first).toMatchObject({ harnessId: 'tower-default', harnessVersion: 1 });
  });
});
