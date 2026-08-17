// Owns Pi tool surface assembly, MCP tool adaptation, and hook wiring.
// Public API: buildPiToolAssembly.

import path from 'path';
import {
  createReadTool,
  createBashTool,
  createEditTool,
  createWriteTool,
  createGrepTool,
  createFindTool,
  createLsTool,
} from '@earendil-works/pi-coding-agent';
import { config, DEFAULT_RUNTIME_BOX_MATERIALIZED_SKILLS } from '../../config.js';
import { queryOne } from '../../db/pg-repo.js';
import { buildToolGuard, wrapPiTools, resolveSessionProjectRoot } from '../../services/pm/project-access.js';
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
import type { ResolvedHarness } from '../../services/harness/harness-types.js';
import type { EngineCallbacks, RunOpts } from '../types.js';
import { createAskUserQuestionTool } from '../pi-ask-user-tool.js';
import { createCredentialVaultInputTool } from '../pi-credential-vault-tool.js';
import { createWebFetchTool, createWebSearchTool } from '../pi-web-tools.js';
import { createMemorySearchTool } from '../pi-memory-search-tool.js';
import { createConversationSearchTool } from '../pi-conversation-search-tool.js';
import { createSessionTranscriptReadTool } from '../pi-session-transcript-tool.js';
import { createExcelReadTool, createExcelQueryTool } from '../pi-finance-tools.js';
import { createPdfReadTool, createExcelWriteTool, createExcelDiffTool } from '../pi-finance-tools-extra.js';
import { createTodoWriteTool } from '../pi-todo-tool.js';
import { sharedTaskCreateTool, sharedTaskUpdateTool, sharedTaskListTool } from '../pi-shared-task-tool.js';
import { createRuntimeBoxPiTools } from '../pi-runtime-box-tools.js';
import { createPdfAwareReadTool } from '../pi-pdf-aware-read-tool.js';
import { createPdfViewTool } from '../pi-pdf-view-tool.js';
import { createPdfExportTool } from '../pi-pdf-export-tool.js';
import { createCadViewTool } from '../pi-cad-view-tool.js';
import { createPublishSiteTool } from '../pi-publish-tool.js';
import { createPresentFileTool } from '../pi-present-file-tool.js';
import { createPersonalNoteAppendTool } from '../pi-personal-note-tool.js';
import { createSessionAttachmentPromoteTool, createSessionAttachmentResolveTool } from '../pi-session-attachment-tool.js';
import { createDeliverDirectoryTool, createDeliverFileTool } from '../pi-file-exchange-tool.js';
import { createSkillsListTool, createSkillsReadTool } from '../pi-skill-tools.js';
import { createRuntimeGuideListTool, createRuntimeGuideReadTool } from '../pi-guide-tools.js';
import { createPrimaryAgentProfileTools, createPrimaryAgentProjectTool, createPrimaryAgentStaffingTools } from '../pi-primary-agent-tools.js';
import { formatPiToolCategorySummary } from '../pi-tool-categories.js';
import { mcpServerToPiTools } from '../pi-mcp-adapter.js';
import { loadProjectMcpTools } from '../../services/project-mcp/project-mcp-loader.js';
import { createPiHarnessCapabilityTools } from '../pi-harness-capability-tools.js';
import { createConnectionStatusTool } from '../pi-connection-status-tool.js';
import { createAIServiceKnowledgeTools } from '../pi-ai-service-knowledge-tools.js';
import { resolveWorkbenchRollout } from '../../services/runtime-box/workbench-rollout-registry.js';

export interface PiToolAssembly {
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

export async function buildPiToolAssembly(params: {
  sessionId: string;
  opts: RunOpts;
  callbacks?: EngineCallbacks;
  registry: any;
  parentSessionFile: string | undefined;
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

  // AI에는 bash 하나만 보인다. Project Runtime이 활성인 세션은 role과 무관하게
  // native host bash를 숨기고, 뒤에서 Project authority에 맞는 Worker/compat executor를 연결한다.
  // Tower source처럼 Project Runtime 대상이 아닌 운영 세션만 native host bash를 받는다.
  // Credential-dependent Project commands therefore always stay on the Project execution plane.
  const hostBashEnabled = !runtimeBoxEnabled;
  const hostBashTools = hostBashEnabled
    ? [createBashTool(opts.cwd, {
        spawnHook: createTowerSessionBashSpawnHook(sessionId),
      })]
    : [];

  const readTool = createPdfAwareReadTool({
    cwd: opts.cwd,
    sessionId,
    userId: opts.userId,
    userRole: opts.userRole,
    projectId: opts.projectId,
  });

  let piTools: any[] = [
    readTool,
    ...hostBashTools,
    createEditTool(opts.cwd),
    createWriteTool(opts.cwd),
    createGrepTool(opts.cwd),
    createFindTool(opts.cwd),
    createLsTool(opts.cwd),
  ];
  const guard = buildToolGuard({
    role: opts.userRole || 'member',
    allowedPath: opts.allowedPath,
    accessiblePaths: opts.accessiblePaths,
    readOnlyPaths: opts.readOnlyPaths,
    denyImplicitBash: opts.denyImplicitBash,
    channelSafeToolsOnly: opts.channelSafeToolsOnly,
    sessionProjectRoot,
    maintenanceGrant: opts.maintenanceGrant,
  });

  // Only the explicit compatibility Harness keeps Tower's legacy full tool surface.
  // Every Registry/custom Harness is compiled from its declared capability allowlist;
  // unknown or unimplemented capabilities fail closed before the run starts.
  if (harness.source !== 'legacy-default') {
    const compiled = createPiHarnessCapabilityTools(harness, { userId: opts.userId, projectId: opts.projectId, evalFixtures: opts.harnessEvalToolFixtures });
    const knowledgeTools = opts.serviceKnowledgeSnapshot ? createAIServiceKnowledgeTools(opts.serviceKnowledgeSnapshot) : [];
    const capabilityTools = wrapPiTools([...compiled.tools, ...knowledgeTools], guard, { projectRoot: sessionProjectRoot });
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

  piTools = wrapPiTools(piTools, guard, { projectRoot: sessionProjectRoot });
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
  const runtimeBoxTools = runtimeBoxEnabled
    ? createRuntimeBoxPiTools({
        userId: opts.userId as number,
        sessionId,
        projectId: opts.projectId as string,
        projectName,
        userRole: opts.userRole,
        projectRoot: sessionProjectRoot,
        workbenchRolloutEnabled,
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
    askUser: callbacks?.askUser || (async () => '취소'),
  };
  const deliverFileTool = createDeliverFileTool(fileExchangeToolContext);
  const deliverDirectoryTool = createDeliverDirectoryTool(fileExchangeToolContext);
  const connectionStatusTool = createConnectionStatusTool({ userId: opts.userId, projectId: opts.projectId });
  const customTools = [
    ...(connectionStatusTool ? [connectionStatusTool] : []),
    createAskUserQuestionTool(callbacks?.askUser || (async () => 'No user answer available.')),
    createCredentialVaultInputTool({ userRole: opts.userRole, projectId: opts.projectId }),
    ...(primaryAgentProjectTool ? [primaryAgentProjectTool] : []),
    ...primaryAgentStaffingTools,
    ...primaryAgentProfileTools,
    createWebFetchTool({ userId: opts.userId, projectId: opts.projectId }),
    createWebSearchTool({ userId: opts.userId, projectId: opts.projectId }),
    createMemorySearchTool({ userId: opts.userId, userRole: opts.userRole, projectId: opts.projectId }),
    createConversationSearchTool({ userId: opts.userId, userRole: opts.userRole, projectId: opts.projectId }),
    createSessionTranscriptReadTool({ userId: opts.userId, userRole: opts.userRole, modelContextWindow: params.modelContextWindow }),
    createSkillsListTool({ userId: opts.userId, username: opts.username, projectId: opts.projectId, cwd: opts.cwd }),
    createSkillsReadTool({ userId: opts.userId, username: opts.username, projectId: opts.projectId, cwd: opts.cwd }),
    createRuntimeGuideListTool({ userRole: opts.userRole }),
    createRuntimeGuideReadTool({ userRole: opts.userRole }),
    createExcelReadTool({ cwd: opts.cwd, projectRoot: sessionProjectRoot, sessionId, userId: opts.userId, userRole: opts.userRole, projectId: opts.projectId }),
    createExcelQueryTool({ cwd: opts.cwd, projectRoot: sessionProjectRoot, sessionId, userId: opts.userId, userRole: opts.userRole, projectId: opts.projectId }),
    createPdfViewTool({ cwd: opts.cwd, sessionId, userId: opts.userId, userRole: opts.userRole, projectId: opts.projectId }),
    createPdfExportTool({ cwd: opts.cwd, projectRoot: sessionProjectRoot, sessionId }),
    createCadViewTool({ cwd: opts.cwd, projectRoot: sessionProjectRoot, sessionId, userId: opts.userId }),
    createPublishSiteTool({ userId: opts.userId, userRole: opts.userRole, cwd: opts.cwd }),
    createPresentFileTool({ userId: opts.userId, userRole: opts.userRole, cwd: opts.cwd }),
    createPersonalNoteAppendTool({ userId: opts.userId, sessionId }),
    createSessionAttachmentResolveTool({ userId: opts.userId, userRole: opts.userRole, sessionId, projectId: opts.projectId }),
    createSessionAttachmentPromoteTool({ userId: opts.userId, userRole: opts.userRole, sessionId, projectId: opts.projectId }),
    ...(deliverFileTool ? [deliverFileTool] : []),
    ...(deliverDirectoryTool ? [deliverDirectoryTool] : []),
    createPdfReadTool({ cwd: opts.cwd, projectRoot: sessionProjectRoot, sessionId, userId: opts.userId, userRole: opts.userRole, projectId: opts.projectId }),
    createExcelWriteTool({ cwd: opts.cwd, projectRoot: sessionProjectRoot, sessionId }),
    createExcelDiffTool({ cwd: opts.cwd, projectRoot: sessionProjectRoot, sessionId }),
    createTodoWriteTool({ sessionId, projectId: opts.projectId, userId: opts.userId }),
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

  let projectMcpTools: any[] = [];
  try {
    projectMcpTools = await loadProjectMcpTools({
      projectRoot: sessionProjectRoot,
      projectId: opts.projectId,
      userId: opts.userId,
      userRole: opts.userRole,
      sessionId,
    });
    if (projectMcpTools.length > 0) {
      console.log(`[Pi] Project MCP tools mounted: ${projectMcpTools.map(t => t.name).slice(0, 20).join(', ')}${projectMcpTools.length > 20 ? '...' : ''}`);
    }
  } catch (err) {
    console.warn('[pi-engine] project MCP mount failed (continuing without project MCP tools):', err);
    projectMcpTools = [];
  }

  const builtinToolNames = [
    'read',
    ...(hostBashEnabled ? ['bash'] : []),
    'edit',
    'write',
    'grep',
    'find',
    'ls',
  ];
  const guardedCustomTools = wrapPiTools([...piTools, ...customTools, ...mcpTools, ...projectMcpTools], guard, { projectRoot: sessionProjectRoot });
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
    allToolNames,
    allCustomTools,
    towerMcpServers,
    promptStaticTokenEstimate,
    piBeforeToolCall,
    piAfterToolCall,
  };
}
