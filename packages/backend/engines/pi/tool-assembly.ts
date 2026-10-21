import { secretaryReadingTools } from './secretary-reading-tools.js';
import { createDashboardTool } from '../pi-dashboard-tool.js';
import { createSleepTool } from '../pi-sleep-tool.js';
import { createPdfObservationTool } from './pdf-observation-tool.js';
import { PdfObservationState } from './pdf-observation-state.js';
// Owns Pi tool surface assembly, MCP tool adaptation, and hook wiring.
// Public API: buildPiToolAssembly.

import path from 'path';
import { requireCurrentAgentExecutionAccess } from '../../services/authority/agent-execution-access.js';
import { wrapBashChangeObserver } from '../../services/workspace/bash-change-observer.js';
import {
  createReadTool,
  createBashTool,
  createLocalBashOperations,
  createEditTool,
  createWriteTool,
  createGrepTool,
  createFindTool,
  createLsTool,
} from '@earendil-works/pi-coding-agent';
import { config, DEFAULT_RUNTIME_BOX_MATERIALIZED_SKILLS } from '../../config.js';
import { queryOne } from '../../db/pg-repo.js';
import { buildToolGuard, wrapPiTools, resolveSessionProjectRoot, isOperatorAccessProjectPath } from '../../services/pm/project-access.js';
import { wrapToolsWithExecutionGateShadow } from '../../services/authority/execution-gate-shadow.js';
import { wrapToolsWithSideEffectLedger } from '../../services/agent-turn/side-effect-tool-wrapper.js';
import { adaptPreToolUseHookToPi, adaptPostToolUseHookToPi, chainBeforeToolCallHooks, chainAfterToolCallHooks } from '../../services/ai/pi-hook-adapter.js';
import { preToolUseConnectorGuard } from '../../services/security/connector-guard.js';
import { preToolUseSandboxPublicGate } from '../../services/security/sandbox-public-gate.js';
import { makePreToolUseWorkspaceGuard } from '../../services/workspace-guard/hook.js';
import { makePostToolUseProvenance } from '../../services/audit/hook.js';
import { isProjectExcluded } from '../../services/runtime-box/policy.js';
import { materializeProjectRegistrySkills } from '../../services/skill/project-skill-materializer.js';
import { readTeamskillsSkillset } from '../../services/skill/teamskills-source.js';
import { getProjectAgentRuntimeProfile } from '../../services/pm/project-agent-profile.js';
import type { ResolvedHarness } from '../../services/harness/harness-types.js';
import type { EngineCallbacks, RunOpts } from '../types.js';
import { createAskUserQuestionTool } from '../pi-ask-user-tool.js';
import { createCredentialVaultInputTool } from '../pi-credential-vault-tool.js';
import { createCredentialVaultAccessTool } from '../pi-credential-vault-access-tool.js';
import { createCredentialVaultStoreTool } from '../pi-credential-vault-store-tool.js';
import { createGatewayKeyIssueAndStoreTool } from '../pi-gateway-key-tool.js';
import { createWebFetchTool, createWebSearchTool } from '../pi-web-tools.js';
import { createNaverSearchTool } from '../pi-naver-search-tool.js';
import { createMemorySearchTool } from '../pi-memory-search-tool.js';
import { createConversationSearchTool } from '../pi-conversation-search-tool.js';
import { createSessionTranscriptReadTool } from '../pi-session-transcript-tool.js';
import { createExcelReadTool, createExcelQueryTool } from '../pi-finance-tools.js';
import { createPdfReadTool, createExcelWriteTool, createExcelDiffTool } from '../pi-finance-tools-extra.js';
import { createTodoWriteTool } from '../pi-todo-tool.js';
import { sharedTaskCreateTool, sharedTaskUpdateTool, sharedTaskListTool } from '../pi-shared-task-tool.js';
import { createRuntimeBoxPiTools } from '../pi-runtime-box-tools.js';
import { createPdfAwareReadTool } from '../pi-pdf-aware-read-tool.js';
import { createProjectFindTool, createProjectGrepTool, createProjectMutationOperations, createProjectQueryOperations } from '../pi-project-query-tools.js';
import { createProjectFileRepresentationSource } from '../../services/project-environment/project-workspace-files.js';
import { createPdfViewTool } from '../pi-pdf-view-tool.js';
import { createPdfExportTool } from '../pi-pdf-export-tool.js';
import { createCadViewTool } from '../pi-cad-view-tool.js';
import { createDocumentParseTool } from '../pi-document-parse-tool.js';
import { createPublishSiteTool } from '../pi-publish-tool.js';
import { createMarkdownArtifactTool } from '../pi-markdown-artifact-tool.js';
import { createPresentFileTool } from '../pi-present-file-tool.js';
import { createSessionAttachmentPromoteTool, createSessionAttachmentResolveTool } from '../pi-session-attachment-tool.js';
import { createDeliverDirectoryTool, createDeliverFileTool } from '../pi-file-exchange-tool.js';
import { createSkillsListTool, createSkillsReadTool } from '../pi-skill-tools.js';
import { createRuntimeGuideListTool, createRuntimeGuideReadTool } from '../pi-guide-tools.js';
import { createPrimaryAgentProfileTools, createPrimaryAgentProjectTool, createPrimaryAgentStaffingTools } from '../pi-primary-agent-tools.js';
import { formatPiToolCategorySummary } from '../pi-tool-categories.js';
import { mcpServerToPiTools } from '../pi-mcp-adapter.js';
import { createProjectMcpGatewayTools } from '../../services/project-mcp/project-mcp-loader.js';
import { createSessionMcpServerChecker } from '../../services/session/session-mcp-selection.js';
import { createPiHarnessCapabilityTools } from '../pi-harness-capability-tools.js';
import { createConnectionStatusTool } from '../pi-connection-status-tool.js';
import { createAIServiceKnowledgeTools } from '../pi-ai-service-knowledge-tools.js';
import { resolveWorkbenchRollout } from '../../services/runtime-box/workbench-rollout-registry.js';
import { createHostCredentialBashOperations } from '../../services/runtime-box/workbench-host-credential-operations.js';
import { createDecisionEvaluateTool } from '../pi-decision-tool.js';

export interface PiToolAssembly {
  operatorHostAccess: boolean;
  allToolNames: string[];
  allCustomTools: any[];
  towerMcpServers: Record<string, any>;
  promptStaticTokenEstimate: number;
  piBeforeToolCall: any;
  piAfterToolCall: any;
}

function createTowerSessionBashSpawnHook(sessionId: string) {
  return ({ command, cwd, env }: { command: string; cwd: string; env: Record<string, string | undefined> }) => ({
    command,
    cwd,
    env: {
      ...env,
      TOWER_SESSION_ID: sessionId,
    },
  });
}

/** Current Agent switch and requester role determine native host access.
 * Re-read the switch each turn; execution additionally checks current DB role.
 * No separate deployment allowlist or approval is required.
 */
export async function resolveOperatorHostAccess(input: { projectId?: string; userRole?: string; channelSafeToolsOnly?: boolean }): Promise<boolean> {
  if (input.channelSafeToolsOnly) return false;
  if (!input.projectId || !['admin', 'operator'].includes(input.userRole || '')) return false;
  const currentAgentAuthority = await getProjectAgentRuntimeProfile(input.projectId).catch(() => null);
  return currentAgentAuthority?.authorityPolicy?.superuser === true
    && ['active', 'ready'].includes(currentAgentAuthority.status);
}

export async function buildPiToolAssembly(params: {
  sessionId: string;
  opts: RunOpts;
  callbacks?: EngineCallbacks;
  registry: any;
  parentSessionFile: string | undefined;
  pdfObservationState?: PdfObservationState;
  projectName: string;
  towerPrompt: string;
  memoryContext: string | null;
  harness: ResolvedHarness;
  modelContextWindow?: number;
}): Promise<PiToolAssembly> {
  const { sessionId, opts, callbacks, projectName, towerPrompt, memoryContext, harness } = params;

  if (harness.engine !== 'pi') {
    throw new Error(`Pi tools cannot use ${harness.engine} Harness ${harness.id}@${harness.version}`);
  }

  if (opts.secretaryConversation) {
    const tools=opts.userId && opts.secretarySourceRead ? secretaryReadingTools(opts.userId,opts.secretarySourceRead) : [];
    return {operatorHostAccess:false,allToolNames:tools.map(t=>t.name),allCustomTools:tools,towerMcpServers:{},promptStaticTokenEstimate:Math.ceil(towerPrompt.length/4),piBeforeToolCall:undefined,piAfterToolCall:undefined};
  }
  if (opts.initialInterview) return { operatorHostAccess:false, allToolNames:[], allCustomTools:[], towerMcpServers:{}, promptStaticTokenEstimate:Math.ceil(towerPrompt.length/4), piBeforeToolCall:undefined, piAfterToolCall:undefined };
  const projectRootFromOpts = opts.sessionProjectRoot;
  const projectRootFromCwd = !projectRootFromOpts ? resolveSessionProjectRoot(opts.cwd) ?? undefined : undefined;
  const projectRootFromId = !projectRootFromOpts && !projectRootFromCwd && opts.projectId
    ? (await queryOne<{ root_path: string | null }>('SELECT root_path FROM projects WHERE id = $1', [opts.projectId]))?.root_path ?? undefined
    : undefined;
  const sessionProjectRoot = projectRootFromOpts ?? projectRootFromCwd ?? projectRootFromId;
  const projectFolderName = sessionProjectRoot ? path.basename(sessionProjectRoot) : undefined;
  const runtimeBoxEnabled =
    config.runtimeBox.enabled &&
    !!opts.userId &&
    !!opts.projectId &&
    !isProjectExcluded(opts.projectId, projectName) &&
    !(projectFolderName && isProjectExcluded(projectFolderName, projectName));

  // AI에는 bash 하나만 보인다. 일반 Project Agent는 Worker/compat executor를 사용한다.
  // admin/operator가 Operator access를 켠 Agent를 사용할 때 native host bash를 구성한다.
  // 이 경로는 Operator OS 사용자의 기존 ~/.ssh, ~/.azure, ~/tower, ~/workspace 접근을 그대로 사용한다.
  // Identity/instruction remain pinned to the immutable Session snapshot, but
  // Operator access is a revocable execution authority and must use the current
  // Project policy on every turn. Otherwise an existing Session keeps stale
  // host access after disable—or cannot gain it after enable.
  const operatorHostAccess = await resolveOperatorHostAccess({ projectId: opts.projectId, userRole: opts.userRole, channelSafeToolsOnly: opts.channelSafeToolsOnly });
  const hostBashEnabled = operatorHostAccess;
  const unavailableHostFallback = !runtimeBoxEnabled && !operatorHostAccess;
  const unavailableBashTools = unavailableHostFallback ? [createBashTool(opts.cwd, {
    operations: { exec: async () => { throw new Error('AGENT_EXECUTION_PLANE_UNAVAILABLE: no Project executor or platform-approved Agent host binding; host fallback is disabled'); } },
  })] : [];
  const hostBashTools = hostBashEnabled
    ? [createBashTool(opts.cwd, {
        spawnHook: createTowerSessionBashSpawnHook(sessionId),
        operations: {
          exec: async (command, cwd, options) => {
            const access = await requireCurrentAgentExecutionAccess({ projectId: opts.projectId, userId: opts.userId });
            // Check current role and switch, not the cached Session authority.
            if (!await resolveOperatorHostAccess({ projectId: opts.projectId, userRole: access.userRole })) {
              throw new Error('AGENT_PLATFORM_EXECUTION_DENIED: current platform authorization is required');
            }
            return createHostCredentialBashOperations({
              projectId: opts.projectId!, userId: opts.userId!, projectRoot: sessionProjectRoot, base: createLocalBashOperations(),
            }).exec(command, cwd, options);
          },
        },
      })]
    : [];

  if (operatorHostAccess && hostBashTools[0]) {
    hostBashTools[0].description += ' Operator access is enabled: this bash executes on the Tower backend host as its OS user, not on the Project Worker or the user browser computer. Existing file, credential, and approval guards still apply. Never print private keys or other secrets.';
  }

  // Observe only this actual host execution plane; never inspect a remote Worker's host mirror.
  for (let i = 0; i < hostBashTools.length; i++) {
    hostBashTools[i] = wrapBashChangeObserver(hostBashTools[i], { cwd: opts.cwd, sessionId });
  }

  const projectSource = !operatorHostAccess && opts.projectId && opts.userId && sessionProjectRoot
    ? await createProjectFileRepresentationSource({ projectId: opts.projectId, projectRoot: sessionProjectRoot, actorUserId: opts.userId, actorRole: opts.userRole })
    : undefined;
  const projectQueryOperations = !operatorHostAccess && opts.projectId && opts.userId && sessionProjectRoot
    ? createProjectQueryOperations({ projectId: opts.projectId, projectRoot: sessionProjectRoot, actorUserId: opts.userId, actorRole: opts.userRole })
    : undefined;
  const projectMutationOperations = !operatorHostAccess && opts.projectId && opts.userId && sessionProjectRoot
    ? createProjectMutationOperations({ projectId: opts.projectId, projectRoot: sessionProjectRoot, actorUserId: opts.userId, actorRole: opts.userRole })
    : undefined;
  const readTool = createPdfAwareReadTool({
    cwd: opts.cwd,
    sessionId,
    userId: opts.userId,
    userRole: opts.userRole,
    projectId: opts.projectId,
    projectRoot: sessionProjectRoot,
    ...(projectSource ? { projectSource } : {}),
  });

  let piTools: any[] = [
    readTool,
    ...hostBashTools,
    ...unavailableBashTools,
    createEditTool(opts.cwd, projectMutationOperations ? { operations: projectMutationOperations.edit } : undefined),
    createWriteTool(opts.cwd, projectMutationOperations ? { operations: projectMutationOperations.write } : undefined),
    projectQueryOperations ? createProjectGrepTool({ projectId: opts.projectId!, projectRoot: sessionProjectRoot!, actorUserId: opts.userId!, actorRole: opts.userRole }) : createGrepTool(opts.cwd),
    projectQueryOperations ? createProjectFindTool({ projectId: opts.projectId!, projectRoot: sessionProjectRoot!, actorUserId: opts.userId!, actorRole: opts.userRole }) : createFindTool(opts.cwd),
    createLsTool(opts.cwd, projectQueryOperations ? { operations: projectQueryOperations.ls } : undefined),
  ];
  const guardOptions = {
    role: opts.userRole || 'member',
    allowedPath: opts.allowedPath,
    accessiblePaths: opts.accessiblePaths,
    readOnlyPaths: opts.readOnlyPaths,
    denyImplicitBash: opts.denyImplicitBash,
    channelSafeToolsOnly: opts.channelSafeToolsOnly,
    sessionProjectRoot,
    maintenanceGrant: opts.maintenanceGrant,
  };
  const guard = buildToolGuard(guardOptions);
  const resolveGuard = async (_toolName: string, input: Record<string, unknown>) => {
    let operatorWriteRoot: string | undefined;
    const userId = opts.userId;
    if (opts.userRole === 'operator' && sessionProjectRoot && userId) {
      const targets = [input.file_path, input.path, input.notebook_path, ...(Array.isArray(input.files) ? input.files : [])]
        .filter((value): value is string => typeof value === 'string');
      // Shell commands retain their host execution gate and damage guards; this is not an OS sandbox.
      // Structured file tools receive the same current Project-scoped Operator access,
      // including tools whose path argument is named `path` (Read/Ls/Find/artifacts).
      if (await isOperatorAccessProjectPath(sessionProjectRoot, userId)
        && (await Promise.all(targets.map(target => isOperatorAccessProjectPath(path.resolve(sessionProjectRoot, target), userId)))).every(Boolean)) {
        operatorWriteRoot = sessionProjectRoot;
      }
    }
    return buildToolGuard({ ...guardOptions, operatorWriteRoot });
  };

  // Only the explicit compatibility Harness keeps Tower's legacy full tool surface.
  // Every Registry/custom Harness is compiled from its declared capability allowlist;
  // unknown or unimplemented capabilities fail closed before the run starts.
  // A deployment-bound Agent with current host policy is an explicit platform surface.
  // It must not lose host bash because an older Session pinned a restricted
  // Harness. Disabling Operator access immediately restores that pinned Harness.
  if (harness.source !== 'legacy-default' && !operatorHostAccess) {
    const compiled = createPiHarnessCapabilityTools(harness, { userId: opts.userId, projectId: opts.projectId, evalFixtures: opts.harnessEvalToolFixtures });
    const knowledgeTools = opts.serviceKnowledgeSnapshot ? createAIServiceKnowledgeTools(opts.serviceKnowledgeSnapshot) : [];
    const capabilityTools = wrapPiTools([...compiled.tools, ...knowledgeTools], guard, { projectRoot: sessionProjectRoot, resolveGuard });
    const allCustomTools = wrapToolsWithSideEffectLedger(wrapToolsWithExecutionGateShadow(capabilityTools, {
      userId: opts.userId,
      userRole: opts.userRole,
      projectId: opts.projectId,
      projectMember: !!opts.projectId,
      projectRole: opts.projectId ? 'member' : undefined,
      executionSurface: 'host',
      sessionId,
      cwd: opts.cwd,
      policy: null,
    }), { sessionId });
    const allToolNames = allCustomTools
      .map((tool: any) => tool?.name)
      .filter((name: unknown): name is string => typeof name === 'string' && name.length > 0);
    const expectedToolNames = [...compiled.expectedToolNames, ...knowledgeTools.map((tool) => tool.name)].sort();
    const unexpected = allToolNames.filter((name) => !expectedToolNames.includes(name));
    const missing = expectedToolNames.filter((name) => !allToolNames.includes(name));
    if (unexpected.length > 0 || missing.length > 0) {
      throw new Error(`Restricted Harness tool surface mismatch: unexpected=${unexpected.join(',') || 'none'} missing=${missing.join(',') || 'none'}`);
    }
    console.log(`[Pi] Restricted Harness tools: ${harness.id}@${harness.version} ${allToolNames.join(', ')}`);
    return {
      operatorHostAccess,
      allToolNames,
      allCustomTools,
      towerMcpServers: {},
      promptStaticTokenEstimate: Math.ceil(towerPrompt.length / 4) + allToolNames.length * 300,
      piBeforeToolCall: chainBeforeToolCallHooks([
        adaptPreToolUseHookToPi(preToolUseConnectorGuard, sessionId, opts.cwd),
      ]),
      piAfterToolCall: chainAfterToolCallHooks([]),
    };
  }

  piTools = wrapPiTools(piTools, guard, { projectRoot: sessionProjectRoot, resolveGuard });
  console.log(`[Pi] ToolGuard active (role=${opts.userRole || 'member'}, accessiblePaths=${opts.accessiblePaths === null ? 'admin' : opts.accessiblePaths?.length ?? 'none'}, sessionProjectRoot=${sessionProjectRoot || 'none'}, hostBash=${hostBashEnabled ? 'enabled' : 'hidden-project-runtime'})`);

  if (runtimeBoxEnabled && sessionProjectRoot && config.runtimeBox.materializeSkills) {
    const skillNames = readTeamskillsSkillset(DEFAULT_RUNTIME_BOX_MATERIALIZED_SKILLS);
    if (skillNames.length > 0) {
      try {
        const result = materializeProjectRegistrySkills({
          projectRootPath: sessionProjectRoot,
          skillNames,
          storageMode: 'bind-ro',
        });
        console.log(`[Pi] Runtime Box managed skills materialized: ok=${result.ok}, materialized=${result.materialized.map(s => s.name).join(',') || 'none'}, skipped=${result.skipped.map(s => s.name).join(',') || 'none'}, pruned=${result.pruned.join(',') || 'none'}`);
      } catch (err) {
        console.warn('[Pi] Runtime Box managed skill materialization failed; continuing without managed skill assets:', err);
      }
    }
  }

  // Project rollout is read from PostgreSQL during every turn's async tool
  // assembly, so cohort enable/disable changes need no backend restart.
  const workbenchRolloutEnabled = runtimeBoxEnabled
    ? (await resolveWorkbenchRollout(opts.projectId as string)).enabled
    : false;
  const runtimeBoxTools = runtimeBoxEnabled && !operatorHostAccess
    ? createRuntimeBoxPiTools({
        userId: opts.userId as number,
        sessionId,
        projectId: opts.projectId as string,
        projectName,
        userRole: opts.userRole,
        projectRoot: sessionProjectRoot,
        workbenchRolloutEnabled,
        runtimeBoxCompatibilityEnabled: config.runtimeBox.compatibilityEnabled,
      })
    : [];

  // Legacy Pi in-process `agent` custom tool is retired.
  // User-facing “subagent” requests route through agent-worker MCP tools instead,
  // so every support AI has a persistent worker-backed Agent Session.
  // See workspace/decisions/2026-06-14-subagent-requests-route-to-persistent-workers.md.
  const primaryAgentToolContext = { userId: opts.userId, userRole: opts.userRole, projectId: opts.projectId };
  // AI talent-team chat and the visual Staffing Review share the same preview-intent,
  // immutable staffing hash, explicit approval, and idempotent creation command contract.
  // The tool itself rejects calls outside the managed AI talent-team Project.
  const primaryAgentProjectTool = createPrimaryAgentProjectTool(primaryAgentToolContext);
  const primaryAgentProfileTools = createPrimaryAgentProfileTools(primaryAgentToolContext);
  const primaryAgentStaffingTools = createPrimaryAgentStaffingTools(primaryAgentToolContext);
  const fileExchangeToolContext = {
    userId: opts.userId,
    userRole: opts.userRole,
    sessionId,
    projectId: opts.projectId,
    askUser: callbacks?.askUser || (async () => 'Interactive approval unavailable for this execution mode.'),
  };
  const deliverFileTool = createDeliverFileTool(fileExchangeToolContext);
  const deliverDirectoryTool = createDeliverDirectoryTool(fileExchangeToolContext);
  const connectionStatusTool = createConnectionStatusTool({ userId: opts.userId, projectId: opts.projectId });
  const customTools = [
    ...(connectionStatusTool ? [connectionStatusTool] : []),
    createDecisionEvaluateTool({ userId: opts.userId, projectId: opts.projectId, sessionId }),
    createAskUserQuestionTool(callbacks?.askUser || (async () => 'No user answer available.')),
    createCredentialVaultInputTool({ userId: opts.userId, userRole: opts.userRole, projectId: opts.projectId }),
    ...(() => { const tool = createCredentialVaultAccessTool({ userId: opts.userId, userRole: opts.userRole, projectId: opts.projectId, channelSafeToolsOnly: opts.channelSafeToolsOnly }); return tool ? [tool] : []; })(),
    ...(() => { const tool = createCredentialVaultStoreTool({ userId: opts.userId, userRole: opts.userRole, projectId: opts.projectId, channelSafeToolsOnly: opts.channelSafeToolsOnly }); return tool ? [tool] : []; })(),
    ...(() => { const tool = createGatewayKeyIssueAndStoreTool({ userId: opts.userId, userRole: opts.userRole, projectId: opts.projectId, channelSafeToolsOnly: opts.channelSafeToolsOnly }); return tool ? [tool] : []; })(),
    ...(primaryAgentProjectTool ? [primaryAgentProjectTool] : []),
    ...primaryAgentStaffingTools,
    ...primaryAgentProfileTools,
    createWebFetchTool({ userId: opts.userId, projectId: opts.projectId }),
    createWebSearchTool({ userId: opts.userId, projectId: opts.projectId }),
    createNaverSearchTool({ userId: opts.userId, projectId: opts.projectId }),
    createMemorySearchTool({ userId: opts.userId, userRole: opts.userRole, projectId: opts.projectId }),
    createConversationSearchTool({ userId: opts.userId, userRole: opts.userRole, projectId: opts.projectId, sessionId }),
    createSessionTranscriptReadTool({ userId: opts.userId, userRole: opts.userRole, modelContextWindow: params.modelContextWindow }),
    createSkillsListTool({ userId: opts.userId, username: opts.username, projectId: opts.projectId, cwd: opts.cwd }),
    createSkillsReadTool({
      userId: opts.userId, username: opts.username, projectId: opts.projectId, cwd: opts.cwd, projectRoot: sessionProjectRoot,
      resolveAssetExecution: async () => {
        const access = await requireCurrentAgentExecutionAccess({ projectId: opts.projectId, userId: opts.userId });
        const currentHostAccess = await resolveOperatorHostAccess({ projectId: opts.projectId, userRole: access.userRole, channelSafeToolsOnly: opts.channelSafeToolsOnly });
        if (currentHostAccess !== operatorHostAccess) return 'unavailable';
        return currentHostAccess ? 'operator-host' : runtimeBoxEnabled ? 'project-executor' : 'unavailable';
      },
    }),
    createRuntimeGuideListTool({ userRole: opts.userRole }),
    createRuntimeGuideReadTool({ userRole: opts.userRole }),
    createExcelReadTool({ cwd: opts.cwd, projectRoot: sessionProjectRoot, sessionId, userId: opts.userId, userRole: opts.userRole, projectId: opts.projectId }),
    createExcelQueryTool({ cwd: opts.cwd, projectRoot: sessionProjectRoot, sessionId, userId: opts.userId, userRole: opts.userRole, projectId: opts.projectId }),
    createPdfObservationTool(params.pdfObservationState || new PdfObservationState()),
    createPdfViewTool({
      cwd: opts.cwd,
      sessionId,
      userId: opts.userId,
      userRole: opts.userRole,
      projectId: opts.projectId,
      projectRoot: sessionProjectRoot,
      projectSource,
    }),
    createDocumentParseTool({ cwd: opts.cwd, projectRoot: sessionProjectRoot, projectId: opts.projectId, userId: opts.userId, sessionId, projectSource }),
    createPdfExportTool({ cwd: opts.cwd, projectRoot: sessionProjectRoot, sessionId }),
    createCadViewTool({ cwd: opts.cwd, projectRoot: sessionProjectRoot, sessionId, userId: opts.userId }),
    createPublishSiteTool({ userId: opts.userId, userRole: opts.userRole, cwd: opts.cwd, sessionId }),
    createMarkdownArtifactTool({ sessionId, userId: opts.userId, userRole: opts.userRole, projectId: opts.projectId, cwd: opts.cwd, projectRoot: sessionProjectRoot }),
    createMarkdownArtifactTool({ sessionId, userId: opts.userId, userRole: opts.userRole, projectId: opts.projectId, cwd: opts.cwd, projectRoot: sessionProjectRoot }, 'read'),
    createMarkdownArtifactTool({ sessionId, userId: opts.userId, userRole: opts.userRole, projectId: opts.projectId, cwd: opts.cwd, projectRoot: sessionProjectRoot }, 'update'),
    createDashboardTool({ userId: opts.userId, userRole: opts.userRole, projectId: opts.projectId, projectRoot: sessionProjectRoot, sessionId }),
    createPresentFileTool({ userId: opts.userId, userRole: opts.userRole, cwd: opts.cwd, projectId: opts.projectId, projectRoot: sessionProjectRoot }),
    createSessionAttachmentResolveTool({ userId: opts.userId, userRole: opts.userRole, sessionId, projectId: opts.projectId }),
    createSessionAttachmentPromoteTool({ userId: opts.userId, userRole: opts.userRole, sessionId, projectId: opts.projectId }),
    ...(deliverFileTool ? [deliverFileTool] : []),
    ...(deliverDirectoryTool ? [deliverDirectoryTool] : []),
    createPdfReadTool({ cwd: opts.cwd, projectRoot: sessionProjectRoot, sessionId, userId: opts.userId, userRole: opts.userRole, projectId: opts.projectId }),
    createExcelWriteTool({ cwd: opts.cwd, projectRoot: sessionProjectRoot, sessionId }),
    createExcelDiffTool({ cwd: opts.cwd, projectRoot: sessionProjectRoot, sessionId }),
    createTodoWriteTool({ sessionId, projectId: opts.projectId, userId: opts.userId }),
    createSleepTool({ sessionId, rootTurnId: opts.rootTurnId }),
    sharedTaskCreateTool,
    sharedTaskUpdateTool,
    sharedTaskListTool,
    ...runtimeBoxTools,
  ];

  const sandboxAvailable =
    config.sandbox.enabled &&
    !!config.sandbox.vmHost &&
    !!opts.userId;
  const towerMcpServers: Record<string, any> = {};
  try {
    if (sandboxAvailable) {
      const { createSandboxMcpServer } = await import('../../mcp/sandbox-server.js');
      towerMcpServers.sandbox = createSandboxMcpServer({ userId: opts.userId!, sessionId });
    }
  } catch (err) {
    console.warn('[pi-engine] sandbox MCP mount failed:', err);
  }
  try {
    if (opts.userId) {
      const { createSessionControlMcpServer } = await import('../../mcp/session-control-server.js');
      towerMcpServers['session-control'] = createSessionControlMcpServer({
        sessionId,
        userId: opts.userId,
        userRole: opts.userRole,
      });
    }
  } catch (err) {
    console.warn('[pi-engine] session-control MCP mount failed:', err);
  }
  try {
    if (opts.userId) {
      const { createScheduleMcpServer } = await import('../../mcp/schedule-server.js');
      towerMcpServers.schedule = createScheduleMcpServer({
        sessionId,
        userId: opts.userId,
        userRole: opts.userRole,
        projectId: opts.projectId,
        cwd: opts.cwd,
      });
    }
  } catch (err) {
    console.warn('[pi-engine] schedule MCP mount failed:', err);
  }

  try {
    if (opts.userId) {
      const { createIssueMcpServer } = await import('../../mcp/issue-server.js');
      towerMcpServers.issue = createIssueMcpServer({
        sessionId,
        userId: opts.userId,
        username: opts.username,
        userRole: opts.userRole,
        projectId: opts.projectId,
        projectName,
        cwd: opts.cwd,
      });
    }
  } catch (err) {
    console.warn('[pi-engine] issue MCP mount failed:', err);
  }

  try {
    if (opts.userId) {
      const { createSpawnMcpServer } = await import('../../mcp/spawn-server.js');
      towerMcpServers['tower-spawn'] = createSpawnMcpServer({
        parentSessionId: sessionId,
        parentUserId: opts.userId,
        parentUsername: opts.username,
        parentRole: opts.userRole,
      });
    }
  } catch (err) {
    console.warn('[pi-engine] spawn MCP mount failed:', err);
  }

  try {
    if (opts.userId) {
      const { createAgentWorkerMcpServer } = await import('../../mcp/agent-worker-server.js');
      towerMcpServers['agent-worker'] = createAgentWorkerMcpServer({
        parentSessionId: sessionId,
        parentUserId: opts.userId,
        parentUsername: opts.username,
        parentRole: opts.userRole,
      });
    }
  } catch (err) {
    console.warn('[pi-engine] agent-worker MCP mount failed:', err);
  }

  let mcpTools: any[] = [];
  try {
    mcpTools = mcpServerToPiTools(towerMcpServers);
    if (mcpTools.length > 0) {
      console.log(`[Pi] MCP tools mounted: ${mcpTools.map(t => t.name).join(', ')}`);
    }
  } catch (err) {
    console.warn('[pi-engine] mcpServerToPiTools failed (continuing without MCP tools):', err);
    mcpTools = [];
  }

  const projectMcpTools = createProjectMcpGatewayTools({
    projectRoot: sessionProjectRoot,
    projectId: opts.projectId,
    userId: opts.userId,
    userRole: opts.userRole,
    sessionId,
    isServerAllowed: createSessionMcpServerChecker({
      sessionId,
      projectId: opts.projectId,
      mcpExcludedServerNames: opts.mcpExcludedServerNames,
    }),
  });
  if (projectMcpTools.length > 0) {
    console.log(`[Pi] Project MCP deferred gateway mounted: ${projectMcpTools.map(t => t.name).join(', ')}`);
  }

  const builtinToolNames = [
    'read',
    ...((hostBashEnabled || unavailableHostFallback) ? ['bash'] : []),
    'edit',
    'write',
    'grep',
    'find',
    'ls',
  ];
  const guardedCustomTools = wrapPiTools([...piTools, ...customTools, ...mcpTools, ...projectMcpTools], guard, { projectRoot: sessionProjectRoot, resolveGuard });
  const allCustomTools = wrapToolsWithSideEffectLedger(wrapToolsWithExecutionGateShadow(guardedCustomTools, {
    userId: opts.userId,
    userRole: opts.userRole,
    projectId: opts.projectId,
    projectMember: !!opts.projectId,
    projectRole: opts.projectId ? 'member' : undefined,
    executionSurface: runtimeBoxEnabled ? 'project-runbox' : 'host',
    sessionId,
    cwd: opts.cwd,
    policy: null,
  }), { sessionId });
  const customToolNames = allCustomTools
    .map((t: any) => t?.name)
    .filter((n: any): n is string => typeof n === 'string' && n.length > 0 && !builtinToolNames.includes(n));
  const allToolNames = [...builtinToolNames, ...customToolNames];
  console.log(`[Pi] Tool activation: ${allToolNames.length} total (${builtinToolNames.length} builtin + ${customToolNames.length} custom): ${customToolNames.slice(0, 10).join(', ')}${customToolNames.length > 10 ? '...' : ''}`);
  console.log(`[Pi] Tool categories: ${formatPiToolCategorySummary(allToolNames)}`);

  const promptStaticTokenEstimate = Math.ceil(
    [towerPrompt, memoryContext || ''].filter(Boolean).join('\n\n').length / 4,
  ) + allToolNames.length * 300;

  const piBeforeToolCall = chainBeforeToolCallHooks([
    adaptPreToolUseHookToPi(preToolUseConnectorGuard, sessionId, opts.cwd),
    adaptPreToolUseHookToPi(
      preToolUseSandboxPublicGate,
      sessionId,
      opts.cwd,
      /^mcp__sandbox__tool_(start|update_visibility)$/,
    ),
    adaptPreToolUseHookToPi(
      makePreToolUseWorkspaceGuard(sessionId),
      sessionId,
      opts.cwd,
      /^(Write|Edit|NotebookEdit|Bash)$/,
    ),
  ]);
  const piAfterToolCall = chainAfterToolCallHooks([
    adaptPostToolUseHookToPi(
      makePostToolUseProvenance(sessionId, { userId: opts.userId, username: opts.username }),
      sessionId,
      opts.cwd,
      /^(Write|Edit|NotebookEdit|Bash)$/,
    ),
  ]);

  return {
    operatorHostAccess,
    allToolNames,
    allCustomTools,
    towerMcpServers,
    promptStaticTokenEstimate,
    piBeforeToolCall,
    piAfterToolCall,
  };
}
