// Owns Pi session prompt/resource-loader assembly.
// Public API: buildPiSessionResources.

import { DefaultResourceLoader, getAgentDir } from '@earendil-works/pi-coding-agent';
import { buildSystemPrompt } from '../../services/system-prompt.js';
import { resolveSessionProjectRoot } from '../../services/pm/project-access.js';
import type { ResolvedHarness } from '../../services/harness/harness-types.js';
import type { RunOpts } from '../types.js';
import { mergeSystemPromptFragments, requireSystemPromptFragmentKeys } from '../../services/system-prompt-fragments.js';
import { getDisabledSkillsForAgentProfile, getSessionProjectAgentRuntimeProfile } from '../../services/pm/project-agent-profile.js';

export const PI_RESPONSE_STYLE_PROMPT = [
  '## Pi engine note',
  '- Follow Tower\'s shared user-experience, audience, collaboration, and permission contract below. Do not add a separate generic brevity style.',
  '- Keep hidden reasoning and minor checks internal; surface only conclusions and evidence useful to the user.',
].join('\n');

const PROJECT_BASH_PROMPT = [
  '## Project Workstation',
  '- Use `bash` as the native shell of this Project Workstation for commands, package installation, tests, builds, provider CLIs, scripts, containers, and servers.',
  '- Commands start in the current Project directory. Normally keep work there, but use host tools or leave the Project directory when the task genuinely requires it.',
  '- Missing software is not a permanent platform restriction: inspect the Workstation and install what the task needs when appropriate. Warn before broad host changes; obtain explicit approval for destructive, irreversible, or external actions.',
  '- Do not choose or infer another Worker, Runtime Box, container, or execution plane. `bash` is the assigned Workstation shell.',
  '- Credential Vault values are injected only into eligible Project `bash` commands. Check redacted presence without printing values; a missing value is not proof that Vault storage or grant failed.',
  '- If Project `bash` is unavailable, report the failure. Never switch to another execution plane automatically.',
].join('\n');

/** Remove retired shell/tool wording from Project prompts without changing global host-session policy. */
export function normalizeProjectBashPrompt(prompt: string): string {
  return prompt
    .split('\n')
    .filter(line => !/project_shell|Project Runtime Box|project Runtime Box|Inside `project_shell`|host bash intentionally does not receive|host-bash `missing`/.test(line))
    .concat('', PROJECT_BASH_PROMPT)
    .join('\n');
}

export interface PiSessionResources {
  resourceLoader: DefaultResourceLoader;
  towerPrompt: string;
  memoryContext: string | null;
}

export async function buildPiSessionResources(params: {
  sessionId: string;
  opts: RunOpts;
  model: any;
  projectName: string;
  harness: ResolvedHarness;
}): Promise<PiSessionResources> {
  const { sessionId, opts, model, projectName, harness } = params;

  if (harness.engine !== 'pi') {
    throw new Error(`Pi resources cannot use ${harness.engine} Harness ${harness.id}@${harness.version}`);
  }

  // Pi SDK auto-discovers AGENTS.md from cwd — let it. Legacy CLAUDE.md is compatibility only.
  // Tower only injects what Pi can't know: user identity, team rules, path restrictions.
  const harnessFragments = requireSystemPromptFragmentKeys(harness.prompt.fragments);
  const systemPromptFragments = mergeSystemPromptFragments(harnessFragments, opts.systemPromptFragments);
  const isolatedSecretary = opts.secretaryConversation === true;
  const includeAgentIdentity = harness.prompt.includeAgentIdentity;
  const rawTowerPrompt = await buildSystemPrompt({
    userId: opts.userId,
    username: opts.username || 'anonymous',
    role: opts.userRole || 'member',
    allowedPath: opts.allowedPath,
    sessionProjectRoot: opts.sessionProjectRoot ?? resolveSessionProjectRoot(opts.cwd) ?? undefined,
    projectId: includeAgentIdentity && !opts.serviceIdentityPrompt ? opts.projectId : undefined,
    serviceIdentityPrompt: includeAgentIdentity ? opts.serviceIdentityPrompt : undefined,
    sessionId: includeAgentIdentity && !opts.serviceIdentityPrompt ? sessionId : undefined,
    includeSessionIdentity: includeAgentIdentity && !opts.serviceIdentityPrompt,
    optionalFragments: systemPromptFragments,
  });
  const baseTowerPrompt = opts.projectId ? normalizeProjectBashPrompt(rawTowerPrompt) : rawTowerPrompt;

  // The retired PM/Ideas feed is no longer injected into Pi runs. Personal
  // continuity is provided by memory-context below, scoped by user + project.
  const towerPrompt = baseTowerPrompt;

  // Pi-first personal continuity memory: same user + same project only.
  const memoryContext = !isolatedSecretary && harness.prompt.includeMemory
    ? await (async () => {
        const { buildMemoryContext } = await import('../../services/ai/memory-context.js');
        return buildMemoryContext({
          sessionId,
          userId: opts.userId,
          projectId: opts.projectId,
          cwd: opts.cwd,
          projectLabel: projectName,
        });
      })()
    : null;

  // Build additional skill paths via the Pi-first materialization adapter.
  let additionalSkillPaths: string[] = [];
  let activeSkillNames: Set<string> | null = null;
  let projectManagedSkillsReady = false;
  try {
    if (isolatedSecretary || !harness.prompt.includeSkills) throw new Error('Harness disables skills');
    const { getMaterializedSkillPaths, getSkillsForSession, hasProjectManagedSkillManifest } = await import('../../services/skill/skill-registry.js');
    projectManagedSkillsReady = hasProjectManagedSkillManifest(opts.cwd);
    additionalSkillPaths = await getMaterializedSkillPaths({
      runtime: 'pi',
      userId: opts.userId,
      projectId: opts.projectId,
      cwd: opts.cwd,
      username: opts.username || null,
    });
    const activeSkills = await getSkillsForSession(opts.userId, opts.projectId, opts.username || null, opts.cwd);
    const agentProfile = opts.projectId
      ? await getSessionProjectAgentRuntimeProfile(sessionId, opts.projectId).catch(() => null)
      : null;
    const disabledSkills = getDisabledSkillsForAgentProfile(agentProfile);
    activeSkillNames = new Set(activeSkills.map((s: any) => s.name).filter((name: string) => !disabledSkills.has(name)));
  } catch {}

  // Dynamic skill cap based on model contextWindow. Approx skill cost: 4K tokens.
  const contextWindow = model?.contextWindow ?? 200_000;
  const maxPiSkills = Math.max(20, Math.floor(contextWindow / 4000));
  const resourceLoader = new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir: getAgentDir(),
    noExtensions: isolatedSecretary || !harness.prompt.includeSkills,
    agentsFilesOverride: !isolatedSecretary && harness.prompt.includeProjectInstructions ? undefined : () => ({ agentsFiles: [] }),
    appendSystemPrompt: memoryContext
      ? [PI_RESPONSE_STYLE_PROMPT, towerPrompt, memoryContext]
      : [PI_RESPONSE_STYLE_PROMPT, towerPrompt],
    additionalSkillPaths,
    noSkills: isolatedSecretary || !harness.prompt.includeSkills || projectManagedSkillsReady,
    // When a project has a managed `.tower/skills/manifest.json`, Tower's
    // additionalSkillPaths are the complete skill source set for that project.
    // Pi's package manager may still discover global user skills from
    // `agentDir`; disable default discovery so same-name skills (e.g.
    // naver-search) cannot keep a host/global <location> in the prompt.
    skillsOverride: !isolatedSecretary && harness.prompt.includeSkills && activeSkillNames ? (base) => {
      const allowedSkillRoots = additionalSkillPaths.map((p) => p.replace(/\/$/, ''));
      const isAllowedPath = (filePath: string) => allowedSkillRoots.some((root) => filePath === root || filePath.startsWith(`${root}/`));
      const blockedByPath = projectManagedSkillsReady
        ? base.skills.filter((s: any) => !isAllowedPath(s.filePath))
        : [];
      if (blockedByPath.length > 0) {
        console.warn(`[Pi] Skill source blocked: resolutionSource=project-manifest blockedReason=native_sdk_or_global_path skills=${blockedByPath.map((s: any) => `${s.name}:${s.filePath || 'unknown'}`).join(',')}`);
      }
      const candidateSkills = projectManagedSkillsReady
        ? base.skills.filter((s: any) => isAllowedPath(s.filePath))
        : base.skills;
      const blockedByName = candidateSkills.filter((s: any) => !activeSkillNames!.has(s.name));
      if (projectManagedSkillsReady && blockedByName.length > 0) {
        console.warn(`[Pi] Skill name blocked: resolutionSource=project-manifest blockedReason=not_in_active_manifest skills=${blockedByName.map((s: any) => s.name).join(',')}`);
      }
      const cap = Math.min(maxPiSkills, candidateSkills.length);
      const filtered = candidateSkills.filter(s => activeSkillNames!.has(s.name));
      const capped = filtered.slice(0, cap);
      if (filtered.length > cap) {
        console.log(`[Pi] Skill cap (ctxWin=${contextWindow}): ${filtered.length} loaded → ${cap} (saved ${filtered.length - cap} skills from prompt)`);
      }
      console.log(`[Pi] Skills loaded: ${capped.length}/${base.skills.length} (cap=${cap}, ctxWin=${contextWindow}, resolutionSource=${projectManagedSkillsReady ? 'project-manifest' : 'compatibility-merged'})`);
      return { skills: capped, diagnostics: base.diagnostics };
    } : undefined,
  });
  await resourceLoader.reload();

  return { resourceLoader, towerPrompt, memoryContext };
}
