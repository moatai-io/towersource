import { buildDownloadCommand, DOWNLOAD_TIMEOUT_MAX_SEC, type DownloadRequest, normalizeDownloadRequest } from '../services/execution/downloads/download-contract.js';
import { requireCurrentAgentExecutionAccess } from '../services/authority/agent-execution-access.js';
import { resolveProjectExecutionContext } from '../services/project-environment/project-execution-context.js';
/**
 * pi-runtime-box-tools.ts — Pi native tools for Project execution.
 *
 * Owns: Pi ToolDefinition surface for the authority-routed Project bash and diagnostic controls.
 * Public API: createRuntimeBoxPiTools(ctx).
 *
 * Why native tools, not MCP: Project Runtime Box is intended to become a Tower
 * first-class execution surface for Pi sessions. MCP remains useful for parity
 * tools, but Runtime Box should share Pi ToolGuard/provenance/governance and avoid
 * the ignored packages/backend/mcp path.
 *
 * See:
 *   workspace/decisions/2026-06-02-project-runtime-box-product-framing.md
 *   workspace/decisions/2026-06-01-project-runtime-plane-stress-test.md §9
 */

import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  getOrCreateBox,
  ensureRunning,
  execInBox,
  execWorkbenchToolMutation,
  RuntimeBoxError,
} from '../services/runtime-box/runtime-box-manager.js';
import {
  listServices,
  stopService,
  readServiceLogs,
  formatServiceList,
} from '../services/runtime-box/service-registry.js';
import {
  classifyCommand,
  isSimpleFileInspectionCommand,
} from '../services/execution/command-classifier.js';
import { RUNTIME_BOX_EXEC_TIMEOUT_MAX_SEC } from '../services/runtime-box/types.js';
import {
  importProjectPrefixWorkbenchTools,
  inspectWorkbenchTools,
  installUvWorkbenchTool,
  listWorkbenchToolRevisions,
  rollbackWorkbenchTools,
} from '../services/runtime-box/workbench-tools.js';
import {
  applyWorkbenchToolChange,
  createCredentialFreeWorkbenchToolRunner,
  previewWorkbenchToolAcquisition,
  previewWorkbenchToolChange,
  WorkbenchToolCommandError,
  type WorkbenchToolAction,
} from '../services/runtime-box/workbench-tool-commands.js';
import type { WorkbenchToolAcquisitionRequest } from '../services/runtime-box/workbench-tool-acquisition-policy.js';
import {
  applyWorkbenchRuntimeRecreate,
  previewWorkbenchRuntimeRecreate,
} from '../services/runtime-box/workbench-runtime-recreate.js';
import type { RuntimeContext } from '../services/runtime-box/types.js';
import { projectWorkbenchToolInventory } from '../services/runtime-box/workbench-tool-inventory.js';
import { assertExperimentalWorkbenchToolAccess, isExperimentalWorkbenchToolVisible } from '../services/runtime-box/workbench-tool-experiment-policy.js';
import { recordFileEdit } from '../services/workspace/file-edit-log.js';
import { isUserFacingSessionFile } from '../services/session/session-file-filter.js';
import { executeWorkbenchRequest, type WorkbenchExecutionRequest } from '../services/execution/execution-broker.js';
import { requiredWorkerExecutorCapabilities, selectProjectExecutionProvider } from '../services/execution/executor-selector.js';
import { resolveProjectEnvironmentDeploymentId } from '../services/project-environment/project-environment-deployment.js';
import { resolveRemoteWorkbenchCredentialEnv } from '../services/runtime-box/workbench-remote-credential-resolution.js';
import { workbenchCredentialDiagnostics } from '../services/runtime-box/workbench-credential-diagnostics.js';
import { prepareWorkbenchCredentials } from '../services/runtime-box/workbench-credential-preparation.js';
import { resolveOperatorExecution } from '../services/runtime-box/workbench-operator-execution.js';
import { resolveEffectiveWorkbenchBinding } from '../services/runtime-box/workbench-effective-binding.js';
import { cancelWorkbenchJob, getWorkbenchJob, listWorkbenchJobs } from '../services/execution/jobs/job-registry.js';
import { requestLocalWorkbenchJobCancel } from '../services/runtime-box/workbench-job-runner.js';
import {
  inspectWorkbenchProcess,
  listWorkbenchProcesses,
  readWorkbenchProcessLogs,
  stopWorkbenchProcess,
} from '../services/runtime-box/workbench-process-control.js';

export interface RuntimeBoxToolContext {
  userId: number;
  sessionId: string;
  projectId: string;
  projectName: string;
  userRole?: string;
  /** Host absolute project root corresponding to Runtime Box /workspace. */
  projectRoot?: string;
}

const EnvSchema = Type.Record(Type.String(), Type.String(), {
  description: 'Extra environment variables for this command. Tower host secrets are not available here by design.',
});

const WorkbenchExecuteParams = Type.Object({
  gwsConnectionId: Type.Optional(Type.String({ minLength: 1, maxLength: 120, pattern: '^[A-Za-z0-9_-]+$', description: 'Existing project-authorized GWS connection ID required by a wrapper. Not a credential value or permission grant.' })),
  credentialRequirements: Type.Optional(Type.Array(Type.String({ pattern: '^[A-Z][A-Z0-9_]{0,62}[A-Z0-9]$' }), { maxItems: 32, uniqueItems: true, description: 'Exact Credential environment names needed by this command or wrapper, never values. Worker execution still checks Vault access and suppresses credentials for install/unsafe commands. Not a permission grant.' })),
  command: Type.String({ minLength: 1, maxLength: 2000, description: 'Command or process to run in the shared Agent Workbench.' }),
  cwd: Type.Optional(Type.String({ description: 'Working directory. Project users use /workspace; Organization Admins may use allowlisted Tower source or organization workspace host paths through Operator Runtime.' })),
  lifecycle: Type.Optional(Type.Union([
    Type.Literal('auto'), Type.Literal('foreground'), Type.Literal('job'), Type.Literal('service'),
  ], { description: 'Default auto. Tower classifies command vs bounded job vs managed service.' })),
  timeoutSec: Type.Optional(Type.Integer({ minimum: 1, maximum: RUNTIME_BOX_EXEC_TIMEOUT_MAX_SEC })),
  env: Type.Optional(EnvSchema),
  service: Type.Optional(Type.Object({
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9-]*$' })),
    port: Type.Optional(Type.Integer({ minimum: 1024, maximum: 65535 })),
    pinned: Type.Optional(Type.Boolean()),
    purpose: Type.Optional(Type.String({ maxLength: 500 })),
    ttlHours: Type.Optional(Type.Integer({ minimum: 1, maximum: 168 })),
  })),
});

const WorkbenchJobListParams = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: 'Newest Jobs to return. Default 20.' })),
});

const WorkbenchJobGetParams = Type.Object({
  jobId: Type.Integer({ minimum: 1, description: 'Durable Workbench Job id.' }),
});

const WorkbenchJobCancelParams = Type.Object({
  jobId: Type.Integer({ minimum: 1, description: 'Queued or running Workbench Job id.' }),
});

const ProjectDownloadParams = Type.Object({
  url: Type.String({ description: 'Public HTTPS URL without credentials, query or fragment.' }),
  destination: Type.String({ description: 'Project-relative new file. Partial data and checkpoint are preserved.' }),
  expectedBytes: Type.Optional(Type.Integer({ minimum: 0 })),
  sha256: Type.Optional(Type.Union([Type.String({ pattern: '^[a-fA-F0-9]{64}$' }), Type.Null()], { description: 'Supply one checksum only. Use null or omit when using MD5; never invent a hash.' })),
  md5: Type.Optional(Type.Union([Type.String({ pattern: '^[a-fA-F0-9]{32}$' }), Type.Null()], { description: 'Official manifest MD5. Use null or omit when using SHA-256. Not adversarial authenticity.' })),
  timeoutSec: Type.Optional(Type.Integer({ minimum: 1, maximum: DOWNLOAD_TIMEOUT_MAX_SEC })),
  connectTimeoutSec: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })),
  idleTimeoutSec: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })),
  maxAttempts: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
});

const ProjectProcessParams = Type.Object({
  action: Type.Union([
    Type.Literal('list'), Type.Literal('status'), Type.Literal('logs'), Type.Literal('stop'),
  ], { description: 'Observe or stop a background process returned by project_shell.' }),
  handle: Type.Optional(Type.String({ pattern: '^(job|service):[1-9][0-9]*$', description: 'Opaque handle returned by project_shell, e.g. job:41 or service:88.' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: 'Maximum processes for action=list. Default 20.' })),
  tail: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000, description: 'Service log lines for action=logs. Default 100.' })),
});

const ProjectShellParams = Type.Object({
  cmd: Type.String({
    minLength: 1,
    maxLength: 2000,
    description: 'Shell command to run in the Project Runtime Box. Examples: npm install, npm test, python main.py, git status.',
  }),
  cwd: Type.Optional(Type.String({
    description: 'Working directory inside the box. Must be /workspace or a subdirectory. Default: /workspace.',
  })),
  timeout_sec: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: RUNTIME_BOX_EXEC_TIMEOUT_MAX_SEC,
    description: `Timeout in seconds. Default 60, max ${RUNTIME_BOX_EXEC_TIMEOUT_MAX_SEC} (15 min). For long-running servers use service_start.`,
  })),
  env: Type.Optional(EnvSchema),
  context_mode: Type.Optional(Type.Union([
    Type.Literal('full'),
    Type.Literal('compact'),
    Type.Literal('none'),
  ], {
    description: 'Runtime Context verbosity. Default: compact for simple file inspection commands, otherwise full. Use full when credentials/services/readiness details matter.',
  })),
});

const WorkbenchToolInspectParams = Type.Object({
  revision_limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: 'Recent revisions to include. Default 20.' })),
});

const WorkbenchToolActionSchema = Type.Union([
  Type.Object({
    kind: Type.Literal('install'),
    manager: Type.Literal('uv-tool'),
    tool: Type.Object({
      name: Type.String({ minLength: 1, maxLength: 128 }),
      version: Type.String({ minLength: 1, maxLength: 128 }),
      entrypoints: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1 }),
    }),
  }),
  Type.Object({ kind: Type.Literal('import-project-prefix') }),
  Type.Object({ kind: Type.Literal('rollback'), targetRevision: Type.Integer({ minimum: 1 }) }),
]);

const WorkbenchToolAcquisitionPreviewParams = Type.Object({
  expectedRevision: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  capability: Type.Union([
    Type.Literal('document-processing'), Type.Literal('data-analysis'), Type.Literal('media-processing'),
    Type.Literal('code-quality'), Type.Literal('network-diagnostics'), Type.Literal('general-utility'),
  ]),
  purpose: Type.String({ minLength: 1, maxLength: 1000 }),
  candidate: Type.Object({
    manager: Type.Literal('uv-tool'), registry: Type.Literal('pypi'),
    tool: Type.Object({
      name: Type.String({ minLength: 1, maxLength: 128 }), version: Type.String({ minLength: 1, maxLength: 128 }),
      entrypoints: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1 }),
    }),
  }),
  access: Type.Object({
    credentials: Type.Union([Type.Literal('none'), Type.Literal('required')]),
    externalNetworkAtRuntime: Type.Boolean(), paidService: Type.Boolean(),
  }),
});

const WorkbenchToolPreviewParams = Type.Object({
  expectedRevision: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  action: WorkbenchToolActionSchema,
  reason: Type.String({ minLength: 1, maxLength: 1000 }),
});

const WorkbenchToolApplyParams = Type.Object({
  intentId: Type.String({ minLength: 1 }),
  proposalHash: Type.String({ minLength: 64, maxLength: 64 }),
  expectedRevision: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  idempotencyKey: Type.String({ minLength: 8, maxLength: 200 }),
  confirmed: Type.Boolean({ description: 'Must be true only after the user explicitly approved the exact preview intent and proposal hash.' }),
});

const WorkbenchRuntimeRecreatePreviewParams = Type.Object({});

const WorkbenchRuntimeRecreateApplyParams = Type.Object({
  intentId: Type.String({ minLength: 1 }),
  proposalHash: Type.String({ minLength: 64, maxLength: 64 }),
  confirmed: Type.Boolean({ description: 'Must be true only after explicit approval of the exact recreate preview.' }),
  serviceImpactAcknowledged: Type.Boolean({ description: 'Must be true separately when preview lists running services.' }),
});

const ServiceListParams = Type.Object({});

const PdfRenderParams = Type.Object({
  path: Type.String({
    minLength: 1,
    maxLength: 1000,
    description: 'PDF path inside the Runtime Box. Use /workspace/... or a path relative to /workspace.',
  }),
  pages: Type.Optional(Type.String({
    maxLength: 100,
    description: 'Pages to render, 1-based. Examples: "1", "1-3", "1,3,5". Default: 1-4. Maximum 12 pages per call.',
  })),
  output_dir: Type.Optional(Type.String({
    maxLength: 1000,
    description: 'Output directory inside /workspace. Default: /workspace/.tower/pdf-renders/<pdf-name>-<timestamp>.',
  })),
  dpi: Type.Optional(Type.Integer({
    minimum: 72,
    maximum: 300,
    description: 'Render DPI. Default 144. Use 200-300 for detailed drawings, but larger images cost more.',
  })),
  format: Type.Optional(Type.Union([Type.Literal('png'), Type.Literal('jpeg')], {
    description: 'Output image format. Default png.',
  })),
});

const ServiceStartParams = Type.Object({
  name: Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: '^[a-z][a-z0-9-]*$',
    description: 'Service name. Lowercase alphanumeric + hyphen. Examples: dev, api, worker.',
  }),
  command: Type.String({
    minLength: 1,
    maxLength: 500,
    description: 'Command to run as a long-running service. Examples: npm run dev, uvicorn main:app --host 0.0.0.0 --port 8000.',
  }),
  cwd: Type.Optional(Type.String({
    description: 'Working directory inside the box. Must be /workspace or a subdirectory. Default: /workspace. Example: /workspace/apps/web',
  })),
  port: Type.Optional(Type.Integer({
    minimum: 1024,
    maximum: 65535,
    description: 'Port the service listens on inside the box. Auto-detected from command if omitted.',
  })),
  pinned: Type.Optional(Type.Boolean({
    description: 'If true, service is not stopped by normal TTL. Requires purpose.',
  })),
  purpose: Type.Optional(Type.String({
    description: 'Required when pinned=true. Describe why this service should be kept running.',
  })),
  ttl_hours: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 168,
    description: 'Time-to-live in hours (default 2). Ignored if pinned=true.',
  })),
});

const ServiceStopParams = Type.Object({
  service_id: Type.Integer({
    minimum: 1,
    description: 'runtime_box_services.id from service_list.',
  }),
});

const ServiceLogsParams = Type.Object({
  service_id: Type.Integer({
    minimum: 1,
    description: 'runtime_box_services.id from service_list.',
  }),
  tail: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 5000,
    description: 'Number of log lines to return. Default 100.',
  })),
});

function formatCompactBanner(ctx: RuntimeContext): string {
  return [
    `Runtime: ${ctx.runtime}`,
    `Project: ${ctx.project_name || ctx.project_id}`,
    `CWD: ${ctx.cwd}`,
    `Limits: ${ctx.box_limits.memory_mb}MB RAM / ${ctx.box_limits.cpu} CPU`,
  ].join(' | ');
}

function formatRuntimeContext(ctx: RuntimeContext, mode: 'full' | 'compact' | 'none'): string | null {
  if (mode === 'none') return null;
  if (mode === 'compact') return formatCompactBanner(ctx);
  return formatBanner(ctx);
}

function formatBanner(ctx: RuntimeContext): string {
  const svcLine = ctx.services_running.length > 0
    ? ctx.services_running.map(s => `${s.name}${s.port ? `:${s.port}` : ''}`).join(', ')
    : '없음';

  const credentialLine = ctx.credential_env && (
    ctx.credential_env.injected.length > 0 ||
    ctx.credential_env.materialized_files.length > 0 ||
    ctx.credential_env.skipped_existing.length > 0 ||
    ctx.credential_env.skipped.length > 0 ||
    ctx.credential_env.suppressed === true
  )
    ? [
      ctx.credential_env.injected.length > 0
        ? `injected ${ctx.credential_env.injected.map(i => `${i.env_name}<-${i.credential_id}`).join(', ')}`
        : '',
      ctx.credential_env.materialized_files.length > 0
        ? `materialized files ${ctx.credential_env.materialized_files.map(i => `${i.env_name}<-${i.credential_id}`).join(', ')}`
        : '',
      ctx.credential_env.skipped_existing.length > 0
        ? `skipped existing ${ctx.credential_env.skipped_existing.map(i => `${i.env_name}<-${i.credential_id}`).join(', ')}`
        : '',
      ctx.credential_env.skipped.length > 0
        ? `skipped ${ctx.credential_env.skipped.map(i => `${i.env_name ? `${i.env_name}<-` : ''}${i.credential_id} (${i.reason})`).join(', ')}`
        : '',
      ctx.credential_env.suppressed === true
        ? `suppressed${ctx.credential_env.suppress_reason ? ` (${ctx.credential_env.suppress_reason})` : ''}`
        : '',
    ].filter(Boolean).join('; ')
    : '없음';

  const readinessLine = ctx.readiness
    ? `${ctx.readiness.baseline}: ${ctx.readiness.capabilities.join(', ')}; doctor: ${ctx.readiness.doctor_command}`
    : 'unknown';
  const harnessLine = ctx.readiness?.harness_preferred?.length
    ? ctx.readiness.harness_preferred.join('; ')
    : '없음';

  return [
    '--- Runtime Context ---',
    `Runtime: project-runtime-box`,
    `Project: ${ctx.project_name || ctx.project_id}`,
    `CWD: ${ctx.cwd}`,
    `Mount: ${ctx.mount}`,
    `Services: ${svcLine}`,
    `Readiness: ${readinessLine}`,
    `Harness preferred: ${harnessLine}`,
    `Credential env: ${credentialLine}`,
    `Limits: ${ctx.box_limits.memory_mb}MB RAM / ${ctx.box_limits.cpu} CPU / idle stop ${ctx.box_limits.idle_stop_minutes}m`,
  ].join('\n');
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    details: undefined,
    ...(isError ? { isError: true } : {}),
  };
}

function workspacePathToHostPath(workspacePath: string, projectRoot?: string): string | null {
  if (!projectRoot || !workspacePath.startsWith('/workspace/')) return null;
  return `${projectRoot}${workspacePath.slice('/workspace'.length)}`;
}

const RUNTIME_BOX_WORKSPACE_PATH_RE = /\/workspace\/[A-Za-z0-9가-힣ㄱ-ㅎㅏ-ㅣ_./\-]+\.[A-Za-z0-9]{1,10}/g;

function cleanRuntimeBoxPath(p: string): string {
  return p.replace(/[.,;:!?)\]}'>"\s]+$/, '');
}

function collectHostPathsFromRuntimeBoxText(text: string, projectRoot?: string): string[] {
  if (!text || !projectRoot) return [];
  const out = new Set<string>();
  RUNTIME_BOX_WORKSPACE_PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RUNTIME_BOX_WORKSPACE_PATH_RE.exec(text)) !== null) {
    const hostPath = workspacePathToHostPath(cleanRuntimeBoxPath(m[0]), projectRoot);
    if (hostPath && isUserFacingSessionFile(hostPath)) out.add(hostPath);
  }
  return [...out];
}

function recordRuntimeBoxTouchedFiles(sessionId: string, toolName: string, paths: string[]): void {
  for (const filePath of new Set(paths.filter(isUserFacingSessionFile))) {
    void recordFileEdit(sessionId, filePath, toolName);
  }
}

function formatRuntimeTiming(totalMs: number, commandMs?: number): string {
  const roundedTotal = Math.max(0, Math.round(totalMs));
  if (typeof commandMs === 'number' && Number.isFinite(commandMs)) {
    const roundedCommand = Math.max(0, Math.round(commandMs));
    const overhead = Math.max(0, roundedTotal - roundedCommand);
    return `Runtime timing: total ${roundedTotal}ms / command ${roundedCommand}ms / overhead approx ${overhead}ms`;
  }
  return `Runtime timing: total ${roundedTotal}ms`;
}

/**
 * Create Pi native Runtime Box tools for one project-scoped session.
 * The project/user/session identity is closed over here so the AI cannot forge it.
 */
export function createRuntimeBoxPiTools(ctx: RuntimeBoxToolContext & { workbenchRolloutEnabled?: boolean; runtimeBoxCompatibilityEnabled?: boolean }): ToolDefinition[] {
  const projectLabel = ctx.projectName || ctx.projectId;

  const experimentalWorkbenchToolsVisible = isExperimentalWorkbenchToolVisible({
    projectId: ctx.projectId,
    role: ctx.userRole,
    sessionId: ctx.sessionId,
    rolloutEnabled: ctx.workbenchRolloutEnabled,
  });

  function assertWorkbenchAccess(): void {
    assertExperimentalWorkbenchToolAccess({
      projectId: ctx.projectId,
      role: ctx.userRole,
      sessionId: ctx.sessionId,
      rolloutEnabled: ctx.workbenchRolloutEnabled,
    });
  }

  async function workbenchRuntime() {
    if (!ctx.projectRoot) throw new WorkbenchToolCommandError('PROJECT_ROOT_REQUIRED', 'Project root is unavailable for Workbench tool management');
    await getOrCreateBox(ctx.projectId, ctx.userId);
    const primitiveRunner = createCredentialFreeWorkbenchToolRunner(async input => {
      return execWorkbenchToolMutation({
        projectId: ctx.projectId,
        projectRoot: ctx.projectRoot!,
        candidateHostPath: input.candidateHostPath,
        candidateContainerPath: input.candidateContainerPath,
        command: input.command,
        cwd: input.cwd,
        candidateMountMode: input.candidateMountMode,
      });
    });
    return {
      projectRoot: ctx.projectRoot,
      dependencies: {
        inspect: inspectWorkbenchTools,
        install: (input: any) => installUvWorkbenchTool({ ...input, run: primitiveRunner }),
        importProjectPrefix: (input: any) => importProjectPrefixWorkbenchTools({ ...input, run: primitiveRunner }),
        rollback: (input: any) => rollbackWorkbenchTools({ ...input, run: primitiveRunner }),
      },
    };
  }

  const workbenchInspectTool: ToolDefinition = {
    name: 'workbench_tool_inspect',
    label: 'Inspect Workbench Tools',
    description: `Inspect managed Workbench tool health and recent immutable revisions for project "${projectLabel}". This is read-only.`,
    promptSnippet: 'Inspect the current managed Workbench tool revision and recovery health before proposing a tool environment change.',
    promptGuidelines: ['Use this before previewing install or rollback.', 'Do not treat recovery_required as healthy or automatically repair it.'],
    parameters: WorkbenchToolInspectParams,
    async execute(_toolCallId: string, params: { revision_limit?: number }) {
      try {
        assertWorkbenchAccess();
        if (!ctx.projectRoot) return textResult('Workbench tool inspection failed: Project root is unavailable.', true);
        const [inspection, revisions] = await Promise.all([
          inspectWorkbenchTools({ projectId: ctx.projectId, projectRoot: ctx.projectRoot }),
          listWorkbenchToolRevisions(ctx.projectId, params.revision_limit ?? 20),
        ]);
        const inventory = projectWorkbenchToolInventory({
          inspection,
          activeManifest: inspection.dbRevision == null
            ? null
            : revisions.find(revision => revision.revision === inspection.dbRevision)?.manifest ?? null,
        });
        return textResult(JSON.stringify({ inspection, inventory, revisions }, null, 2));
      } catch (error: any) {
        return textResult(`Workbench tool inspection failed: ${error?.message || error}`, true);
      }
    },
  } as ToolDefinition;

  const workbenchAcquisitionPreviewTool: ToolDefinition = {
    name: 'workbench_tool_preview_acquisition',
    label: 'Prepare AI Workbench Tool',
    description: `Classify an AI-selected exact local CLI for a capability and create an approval-bound Workbench change preview for project "${projectLabel}".`,
    promptSnippet: 'Use when the task needs a missing local CLI. Select an exact package and entrypoints, disclose separate authority needs, and show the returned approval boundary.',
    promptGuidelines: [
      'The user asks for an outcome; do not make package installation mechanics the product UX.',
      'Never claim autonomous acquisition while package hooks and provenance remain unisolated.',
      'Credentials, paid services, and runtime network authority are separate and must not be bundled into installation.',
      'Never call apply without explicit approval of the exact returned change preview.',
    ],
    parameters: WorkbenchToolAcquisitionPreviewParams,
    async execute(_toolCallId: string, params: { expectedRevision: number | null } & WorkbenchToolAcquisitionRequest) {
      try {
        assertWorkbenchAccess();
        const runtime = await workbenchRuntime();
        const preview = await previewWorkbenchToolAcquisition({
          projectId: ctx.projectId, projectRoot: runtime.projectRoot, expectedRevision: params.expectedRevision,
          request: { capability: params.capability, purpose: params.purpose, candidate: params.candidate, access: params.access },
          actor: { userId: ctx.userId, role: ctx.userRole!, sessionId: ctx.sessionId },
        });
        return textResult(JSON.stringify(preview, null, 2));
      } catch (error: any) {
        return textResult(`Workbench tool acquisition preview failed${error?.code ? ` (${error.code})` : ''}: ${error?.message || error}`, true);
      }
    },
  } as ToolDefinition;

  const workbenchPreviewTool: ToolDefinition = {
    name: 'workbench_tool_preview_change',
    label: 'Preview Workbench Tool Change',
    description: `Create a short-lived server-stored preview intent for an install or rollback in project "${projectLabel}". This does not mutate the Workbench.`,
    promptSnippet: 'Use this to preview an exact Workbench tool install or rollback. Show the full preview and obtain explicit user approval before apply.',
    promptGuidelines: ['Only admin/operator sessions may preview mutations.', 'Never call apply in the same step without explicit user approval of this exact preview.'],
    parameters: WorkbenchToolPreviewParams,
    async execute(_toolCallId: string, params: { expectedRevision: number | null; action: WorkbenchToolAction; reason: string }) {
      try {
        assertWorkbenchAccess();
        const runtime = await workbenchRuntime();
        const preview = await previewWorkbenchToolChange({
          projectId: ctx.projectId, projectRoot: runtime.projectRoot, expectedRevision: params.expectedRevision,
          action: params.action, reason: params.reason,
          actor: { userId: ctx.userId, role: ctx.userRole!, sessionId: ctx.sessionId },
        });
        return textResult(JSON.stringify(preview, null, 2));
      } catch (error: any) {
        return textResult(`Workbench tool preview failed${error?.code ? ` (${error.code})` : ''}: ${error?.message || error}`, true);
      }
    },
  } as ToolDefinition;

  const workbenchApplyTool: ToolDefinition = {
    name: 'workbench_tool_apply_change',
    label: 'Apply Workbench Tool Change',
    description: `Apply one exact user-approved Workbench tool preview intent for project "${projectLabel}".`,
    promptSnippet: 'Call only after explicit user approval of the exact preview intent and hash.',
    promptGuidelines: [
      'Never set confirmed=true without explicit user approval after showing the preview.',
      'Pass the exact intentId, proposalHash, and expectedRevision returned by preview.',
      'Do not use project_shell as a fallback when this controlled apply is refused.',
    ],
    parameters: WorkbenchToolApplyParams,
    async execute(_toolCallId: string, params: { intentId: string; proposalHash: string; expectedRevision: number | null; idempotencyKey: string; confirmed: boolean }) {
      try { assertWorkbenchAccess(); } catch (error: any) { return textResult(`Workbench tool apply refused${error?.code ? ` (${error.code})` : ''}: ${error?.message || error}`, true); }
      if (params.confirmed !== true) return textResult('Workbench tool apply refused: explicit approval is required.', true);
      try {
        const runtime = await workbenchRuntime();
        const applied = await applyWorkbenchToolChange({
          projectId: ctx.projectId, projectRoot: runtime.projectRoot, intentId: params.intentId,
          proposalHash: params.proposalHash, expectedRevision: params.expectedRevision,
          idempotencyKey: params.idempotencyKey, confirmed: true,
          actor: { userId: ctx.userId, role: ctx.userRole!, sessionId: ctx.sessionId },
          dependencies: runtime.dependencies,
        });
        return textResult(JSON.stringify({ ok: true, result: applied }, null, 2));
      } catch (error: any) {
        return textResult(`Workbench tool apply failed${error?.code ? ` (${error.code})` : ''}: ${error?.message || error}`, true);
      }
    },
  } as ToolDefinition;

  const workbenchRuntimeRecreatePreviewTool: ToolDefinition = {
    name: 'workbench_runtime_preview_recreate',
    label: 'Preview Workbench Runtime Recreate',
    description: `Preview stopping exactly the current Runtime and recreating it on the finalized managed revision for project "${projectLabel}". This does not stop anything.`,
    promptSnippet: 'Use only when inspect reports recreate_required. Show revisions, activity evidence, service/process impact, and no-auto-restart policy before asking for approval.',
    promptGuidelines: ['Never call apply without explicit approval of this exact preview.', 'If services exist, obtain separate acknowledgement that they will stop and not auto-restart.'],
    parameters: WorkbenchRuntimeRecreatePreviewParams,
    async execute() {
      try {
        assertWorkbenchAccess();
        if (!ctx.projectRoot) return textResult('Workbench Runtime recreate preview failed: Project root is unavailable.', true);
        const preview = await previewWorkbenchRuntimeRecreate({
          projectId: ctx.projectId, projectRoot: ctx.projectRoot,
          actor: { userId: ctx.userId, role: ctx.userRole!, sessionId: ctx.sessionId },
        });
        return textResult(JSON.stringify(preview, null, 2));
      } catch (error: any) {
        return textResult(`Workbench Runtime recreate preview failed${error?.code ? ` (${error.code})` : ''}: ${error?.message || error}`, true);
      }
    },
  } as ToolDefinition;

  const workbenchRuntimeRecreateApplyTool: ToolDefinition = {
    name: 'workbench_runtime_apply_recreate',
    label: 'Apply Workbench Runtime Recreate',
    description: `Apply one exact user-approved Runtime recreate intent for project "${projectLabel}". Services stop and never auto-restart.`,
    promptSnippet: 'Call only after exact preview approval and separate service impact acknowledgement when required.',
    promptGuidelines: ['Never set confirmed=true without explicit user approval.', 'Never set serviceImpactAcknowledged=true unless the user separately acknowledged listed service interruption.'],
    parameters: WorkbenchRuntimeRecreateApplyParams,
    async execute(_toolCallId: string, params: { intentId: string; proposalHash: string; confirmed: boolean; serviceImpactAcknowledged: boolean }) {
      try { assertWorkbenchAccess(); } catch (error: any) { return textResult(`Workbench Runtime recreate refused${error?.code ? ` (${error.code})` : ''}: ${error?.message || error}`, true); }
      if (params.confirmed !== true) return textResult('Workbench Runtime recreate refused: explicit approval is required.', true);
      if (!ctx.projectRoot) return textResult('Workbench Runtime recreate failed: Project root is unavailable.', true);
      try {
        const result = await applyWorkbenchRuntimeRecreate({
          projectId: ctx.projectId, projectRoot: ctx.projectRoot,
          intentId: params.intentId, proposalHash: params.proposalHash, confirmed: true,
          serviceImpactAcknowledged: params.serviceImpactAcknowledged,
          actor: { userId: ctx.userId, role: ctx.userRole!, sessionId: ctx.sessionId },
        });
        return textResult(JSON.stringify(result, null, 2));
      } catch (error: any) {
        return textResult(`Workbench Runtime recreate failed${error?.code ? ` (${error.code})` : ''}: ${error?.message || error}`, true);
      }
    },
  } as ToolDefinition;

  const workbenchExecuteTool: ToolDefinition = {
    name: 'bash',
    label: 'Bash',
    description: `Run a shell command in the Project execution environment for "${projectLabel}". Commands start in /workspace and stay inside this Project.`,
    promptSnippet: 'Use bash naturally for Project commands, package installation, tests, builds, scripts, and servers. Tower routes this Agent to its Project execution environment; Operator access is a separate native host permission.',
    promptGuidelines: [
      'Use one outcome-oriented request. Tower only infers Job/Service for a single unambiguous invocation; pipelines, compound commands and unknown shell syntax default to foreground.',
      'Risky command patterns fail closed in this unified path.',
      'Long bounded commands return a durable Job handle that can outlive this Session.',
      'For compound or wrapper-based long-running commands, explicitly request lifecycle=service (or lifecycle=job for bounded work). Set service.port explicitly when it cannot be inferred. Managed Services have tracked logs, ports, TTL and stop controls.',
      'Install and combine project-scoped CLI tools freely when safe.',
      'Treat /workspace as the Project root. Only Organization Admins may target allowlisted Tower source or organization workspace host paths; this never grants Credential values or unbounded host access.',
    ],
    parameters: WorkbenchExecuteParams,
    async execute(_toolCallId: string, params: WorkbenchExecutionRequest, signal?: AbortSignal) {
      let credentialSelection: ReturnType<typeof workbenchCredentialDiagnostics> | undefined;
      try {
        const currentAccess = await requireCurrentAgentExecutionAccess(ctx);
        const operatorResolution = resolveOperatorExecution({
          request: params,
          actorRole: currentAccess.userRole,
          projectRoot: ctx.projectRoot,
        });
        const routedParams = operatorResolution.request;
        const deploymentId = resolveProjectEnvironmentDeploymentId();
        const computeSettings = await resolveEffectiveWorkbenchBinding(ctx.projectId, deploymentId);
        const requiredCapabilities = requiredWorkerExecutorCapabilities({ authorityMode: computeSettings?.authorityMode, actorRole: currentAccess.userRole });
        const executionContext = await resolveProjectExecutionContext({
          projectId: ctx.projectId,
          actorUserId: Number(ctx.userId),
          sessionId: ctx.sessionId,
          deploymentId,
          requiredCapabilities,
          expectedProjectRoot: ctx.projectRoot,
        });
        const provider = await selectProjectExecutionProvider({
          projectId: ctx.projectId,
          actorUserId: Number(ctx.userId),
          sessionId: ctx.sessionId,
          projectRoot: executionContext.projectRoot,
          defaultWorkerId: executionContext.preferredExecutorId,
          workstationMode: executionContext.environmentMode === 'legacy-worker-workspace',
          authorityMode: computeSettings?.authorityMode,
          actorRole: currentAccess.userRole,
          deploymentId,
          runtimeBoxCompatibilityEnabled: ctx.runtimeBoxCompatibilityEnabled,
          executionContext,
          request: routedParams,
        });
        const credentialResolution = provider.kind === 'remote-worker'
          ? await prepareWorkbenchCredentials(provider, () => resolveRemoteWorkbenchCredentialEnv({
            projectId: ctx.projectId,
            userId: Number(ctx.userId),
            projectRoot: ctx.projectRoot,
            request: routedParams,
          }))
          : undefined;
        const request = credentialResolution?.request
          ?? { ...routedParams, env: routedParams.env ? { ...routedParams.env } : undefined };
        credentialSelection = credentialResolution
          ? workbenchCredentialDiagnostics(credentialResolution) : undefined;
        const result = await executeWorkbenchRequest({
          request,
          signal,
          context: { projectId: ctx.projectId, userId: ctx.userId, sessionId: ctx.sessionId, ...currentAccess },
          provider,
        });
        const execution = result.execution;
        if (execution.lifecycle === 'service') {
          return textResult(JSON.stringify({
            plan: result.plan,
            credentialSelection,
            process: { handle: `service:${execution.service.id}`, kind: 'service', state: execution.service.status },
            service: execution.service,
          }, null, 2));
        }
        if (execution.lifecycle === 'job') {
          return textResult(JSON.stringify({
            plan: result.plan,
            credentialSelection,
            durable: true,
            process: { handle: `job:${execution.job.id}`, kind: 'job', state: execution.job.status },
            job: execution.job,
          }, null, 2));
        }
        const runtime = execution.result;
        const touchedFiles = collectHostPathsFromRuntimeBoxText([runtime.stdout, runtime.stderr].filter(Boolean).join('\n'), ctx.projectRoot);
        recordRuntimeBoxTouchedFiles(ctx.sessionId, 'bash', touchedFiles);
        return textResult(JSON.stringify({
          plan: result.plan,
          credentialSelection,
          execution: {
            lifecycle: execution.lifecycle,
            outcome: execution.outcome,
            stdout: runtime.stdout,
            stderr: runtime.stderr,
            runtimeContext: credentialResolution ? {
              ...runtime.runtime_context,
              credential_env: {
                ...runtime.runtime_context.credential_env,
                suppressed: credentialResolution.suppressed,
                suppress_reason: credentialResolution.suppressReason,
              },
            } : runtime.runtime_context,
          },
        }, null, 2), !execution.outcome.ok);
      } catch (error) {
        return textResult(JSON.stringify({
          error: `[Project execution error] ${(error as Error).message}`,
          credentialSelection,
          credentialSelectionStatus: credentialSelection ? 'resolved-before-execution-failure' : 'unavailable',
        }, null, 2), true);
      }
    },
  } as ToolDefinition;

  const projectDownloadTool = {
    name: 'project_download', label: 'Project download',
    description: 'Start an authorized public HTTPS download as a bounded resumable Job, never a Service. Observe handle with project_process. running means process liveness; only download.observation=receiving_bytes confirms transfer. blocked/stale/interrupted need diagnosis. No checksum verification unless a manifest checksum supplied. Unknown partial files are never appended blindly. Requires python3 on the executor.',
    parameters: ProjectDownloadParams,
    async execute(_toolCallId: string, params: DownloadRequest) {
      try {
        const normalized = normalizeDownloadRequest(params);
        const command = buildDownloadCommand(normalized);
        const currentAccess = await requireCurrentAgentExecutionAccess(ctx);
        const deploymentId = resolveProjectEnvironmentDeploymentId();
        const computeSettings = await resolveEffectiveWorkbenchBinding(ctx.projectId, deploymentId);
        const requiredCapabilities = requiredWorkerExecutorCapabilities({ authorityMode: computeSettings?.authorityMode, actorRole: currentAccess.userRole });
        const executionContext = await resolveProjectExecutionContext({ projectId: ctx.projectId, actorUserId: Number(ctx.userId), sessionId: ctx.sessionId, deploymentId, requiredCapabilities, expectedProjectRoot: ctx.projectRoot });
        const request = { command, lifecycle: 'job' as const, timeoutSec: normalized.timeoutSec ?? DOWNLOAD_TIMEOUT_MAX_SEC };
        const provider = await selectProjectExecutionProvider({ projectId: ctx.projectId, actorUserId: Number(ctx.userId), sessionId: ctx.sessionId, projectRoot: executionContext.projectRoot, defaultWorkerId: executionContext.preferredExecutorId, workstationMode: executionContext.environmentMode === 'legacy-worker-workspace', authorityMode: computeSettings?.authorityMode, actorRole: currentAccess.userRole, deploymentId, runtimeBoxCompatibilityEnabled: ctx.runtimeBoxCompatibilityEnabled, executionContext, request });
        const result = await executeWorkbenchRequest({ request, context: { projectId: ctx.projectId, userId: ctx.userId, sessionId: ctx.sessionId, ...currentAccess }, provider });
        return textResult(JSON.stringify(result));
      } catch (e) { return textResult(`[Download Error] ${(e as Error).message}`, true); }
    },
  } as ToolDefinition;

  const projectProcessTool: ToolDefinition = {
    name: 'project_process',
    label: 'Project Process',
    description: `Observe logs/status or stop a durable Job or managed Service started by bash in project "${projectLabel}". Job and Service internals share one opaque process handle.`,
    promptSnippet: 'Use project_process for list, status, logs, and stop after bash returns a job:<id> or service:<id> handle.',
    promptGuidelines: [
      'Treat handles as opaque and Project-scoped; never construct a bare numeric id.',
      'Use action=list when resuming work and the handle is unknown.',
      'running is process liveness, not task progress. For downloads inspect download.observation; stale/unverified/interrupted must not be reported as normal transfer.',
      'Use action=logs for both Jobs and Services; Tower selects durable output or service log tail.',
      'Use action=stop for either Job cancellation or Service stop.',
    ],
    parameters: ProjectProcessParams,
    async execute(_toolCallId: string, params: { action: 'list' | 'status' | 'logs' | 'stop'; handle?: string; limit?: number; tail?: number }) {
      try {
        if (params.action === 'list') {
          return textResult(JSON.stringify({ processes: await listWorkbenchProcesses(ctx.projectId, params.limit) }, null, 2));
        }
        if (!params.handle) return textResult('[Project Process Error] handle is required for status, logs, and stop.', true);
        if (params.action === 'status') return textResult(JSON.stringify({ process: await inspectWorkbenchProcess(ctx.projectId, params.handle) }, null, 2));
        if (params.action === 'logs') return textResult(JSON.stringify(await readWorkbenchProcessLogs(ctx.projectId, params.handle, params.tail, Number(ctx.userId)), null, 2));
        return textResult(JSON.stringify(await stopWorkbenchProcess(ctx.projectId, params.handle, Number(ctx.userId)), null, 2));
      } catch (error: any) {
        return textResult(`[Project Process Error${error?.code ? ` ${error.code}` : ''}] ${error?.message || error}`, true);
      }
    },
  } as ToolDefinition;

  const workbenchJobListTool: ToolDefinition = {
    name: 'workbench_job_list', label: 'List Workbench Jobs',
    description: `List durable execution Jobs for project "${projectLabel}".`,
    promptSnippet: 'List recent Workbench Jobs and their durable lifecycle status.',
    promptGuidelines: ['Use after workbench_execute lifecycle=job or when resuming work in a later Session.', 'Environment values are never returned.'],
    parameters: WorkbenchJobListParams,
    async execute(_toolCallId: string, params: { limit?: number }) {
      try { return textResult(JSON.stringify(await listWorkbenchJobs(ctx.projectId, params.limit), null, 2)); }
      catch (error) { return textResult(`[Workbench Job Error] ${(error as Error).message}`, true); }
    },
  } as ToolDefinition;

  const workbenchJobGetTool: ToolDefinition = {
    name: 'workbench_job_get', label: 'Inspect Workbench Job',
    description: `Inspect one durable Workbench Job for project "${projectLabel}", including bounded stdout/stderr and terminal result.`,
    promptSnippet: 'Inspect a Workbench Job by id.',
    promptGuidelines: ['Use the Project-scoped job id returned by workbench_execute or workbench_job_list.'],
    parameters: WorkbenchJobGetParams,
    async execute(_toolCallId: string, params: { jobId: number }) {
      try {
        const job = await getWorkbenchJob(ctx.projectId, params.jobId);
        return job ? textResult(JSON.stringify(job, null, 2)) : textResult(`[Workbench Job Error] Job ${params.jobId} not found`, true);
      } catch (error) { return textResult(`[Workbench Job Error] ${(error as Error).message}`, true); }
    },
  } as ToolDefinition;

  const workbenchJobCancelTool: ToolDefinition = {
    name: 'workbench_job_cancel', label: 'Cancel Workbench Job',
    description: `Request cancellation of one queued or running Workbench Job for project "${projectLabel}".`,
    promptSnippet: 'Cancel a queued or running Workbench Job by id.',
    promptGuidelines: ['Queued Jobs cancel immediately.', 'Running Local Jobs currently observe cancellation at terminal finalization; hard process interruption is a later runner capability.'],
    parameters: WorkbenchJobCancelParams,
    async execute(_toolCallId: string, params: { jobId: number }) {
      try {
        const job = await cancelWorkbenchJob(ctx.projectId, params.jobId);
        const localProcessSignalled = job.status === 'cancel_requested' ? requestLocalWorkbenchJobCancel(job.id) : false;
        return textResult(JSON.stringify({ job, localProcessSignalled }, null, 2));
      }
      catch (error) { return textResult(`[Workbench Job Error] ${(error as Error).message}`, true); }
    },
  } as ToolDefinition;

  const projectShellTool: ToolDefinition = {
    name: 'project_shell_legacy',
    label: 'Project Shell (legacy diagnostic)',
    description: [
      `Run a command inside the Project Runtime Box for project "${projectLabel}".`,
      'This is the terminal for the project, not host bash.',
      'The project folder is mounted read-write at /workspace, so npm install, npm test, python scripts, and git status behave like local development.',
      'Managed skill assets, when enabled for this project, are available under /workspace/.tower/skills/<skill-name>/; do not read or execute host-side skill source paths. Inside Runtime Box, diagnose skill assets with runtime-skill-doctor; do not use host/global registry doctors as the source of truth.',
      'Use this for commands that need the project runtime. For structured file reading/search/editing, prefer Tower file tools (read, grep, find, edit, write); they operate on the same project folder with better provenance.',
      'For PDFs, scanned drawings, specs, and page rendering inside the project, use this Runtime Box rather than sandbox.run(workspace_path=...), because sandbox copies project folders through a small tar limit while Runtime Box reads /workspace directly.',
    ].join(' '),
    promptSnippet: 'Run shell commands inside the current project Runtime Box (/workspace), not on the Tower host. Credential Vault grants are materialized only here, per command; use project_shell—not host bash—for provider CLIs, API adapters, and credential presence checks. Use this for project PDFs/drawings instead of sandbox workspace mounts.',
    promptGuidelines: [
      'Use project_shell for package install, tests, builds, short scripts, git status, and runtime-dependent commands.',
      'Credential Vault values are injected only into eligible project_shell commands. When a command needs an API key, token, login bundle, provider CLI, or credential presence check, always use project_shell even if host bash is also available to an admin/operator.',
      'Never infer that Vault storage or grant failed from a host bash env check. Verify redacted presence and Runtime Context credential_env through project_shell; host bash intentionally does not receive Project Credential Vault secrets.',
      'For bundled managed skill files, use /workspace/.tower/skills/<skill-name>/... inside the Runtime Box. Do not read ~/.claude/skills, ~/tower/data/runtime-skills, or ~/tower/data/skills from project sessions. Use runtime-skill-doctor to inspect the mounted skill layer.',
      'When a project task needs a CLI that is not installed yet, install and use it inside the Runtime Box when safe and project-scoped (for example npm/pip/apt-style project tools, converters, linters, renderers, and analysis CLIs). Do not give up just because the base box is missing a CLI.',
      'For project-local PDFs, scanned drawings, specifications, OCR pre-processing, page image extraction, or contact sheets, prefer harness pdf_view for ordinary visual reading; use project_shell when you need custom preprocessing, specialized CLI tools, or generated intermediate artifacts.',
      'Available base rendering/PDF/drawing tools include tower-html-render, chromium headless, pdfinfo, pdftotext, pdftoppm, qpdf, ghostscript, imagemagick, and Python libraries pypdf, pdfplumber, PyMuPDF/fitz, and Pillow.',
      'For detailed PDF visual/table workflow rules, use runtime_guide_read with name="pdf-analysis".',
      'Do NOT use project_shell for ordinary file editing when edit/write/read/grep/find can do it more safely and with better provenance.',
      'Do NOT let Runtime Box CLI improvisation replace harness contracts for high-trust outputs: existing PDF viewing should use pdf_view; final document/PDF generation should use the export workflow when available. Runtime Box is excellent for project-scoped custom work and dependency installation, not for silently downgrading a requested final artifact.',
      'For long-running servers such as npm run dev or uvicorn, prefer service_start so Tower can track logs, ports, TTL, and pinned state.',
      'Read the Runtime Context banner in the result to verify the project, cwd, mount, limits, and running services.',
      'This is not host bash; Tower host secrets, Docker socket, other projects, and host config are not available by design.',
    ],
    parameters: ProjectShellParams,
    async execute(_toolCallId: string, params: {
      cmd: string;
      cwd?: string;
      timeout_sec?: number;
      env?: Record<string, string>;
      context_mode?: 'full' | 'compact' | 'none';
    }) {
      const classification = classifyCommand(params.cmd);
      const longRunningHint = classification.cls === 'long-running'
        ? `\n\n⚠️ 장기 실행 명령으로 감지됨. service_start를 쓰면 Tower가 포트·로그·TTL을 추적합니다. 추천 서비스명: ${classification.suggested_service_name || 'service'}`
        : '';
      const riskyHint = classification.cls === 'risky'
        ? '\n\n⚠️ 고위험 명령 패턴 감지됨. v1에서는 경고만 제공하지만, 향후 Secure Run 승격 후보입니다.'
        : '';

      const startedAt = Date.now();
      try {
        await requireCurrentAgentExecutionAccess(ctx);
        const box = await getOrCreateBox(ctx.projectId, ctx.userId);
        const result = await execInBox({
          boxId: box.id,
          userId: ctx.userId,
          sessionId: ctx.sessionId,
          cmd: params.cmd,
          cwd: params.cwd,
          timeout_sec: params.timeout_sec,
          env: params.env,
        });
        const totalDurationMs = Date.now() - startedAt;
        const simpleFileInspection = isSimpleFileInspectionCommand(params.cmd);
        const contextMode = params.context_mode ?? (simpleFileInspection ? 'compact' : 'full');
        const runtimeContextText = formatRuntimeContext(result.runtime_context, contextMode);
        const exitLine = result.exit_code !== 0
          ? `\n\n[Exit: ${result.exit_code}${result.timed_out ? ', TIMEOUT' : ''}${result.oom_killed ? ', OOM' : ''}]`
          : '';
        const fileInspectionHint = simpleFileInspection
          ? '\n\nHint: This command only inspected project files. Next time prefer Tower read/grep/find tools; they avoid Runtime Box startup/exec overhead and use the same project file boundary.'
          : '';
        const touchedFiles = collectHostPathsFromRuntimeBoxText(
          [result.stdout, result.stderr].filter(Boolean).join('\n'),
          ctx.projectRoot,
        );
        recordRuntimeBoxTouchedFiles(ctx.sessionId, 'project_shell', touchedFiles);
        return textResult([
          runtimeContextText,
          '--- Output ---',
          result.stdout || '(no stdout)',
          result.stderr ? `\n--- Stderr ---\n${result.stderr}` : '',
          `\n--- ${formatRuntimeTiming(totalDurationMs, result.duration_ms)} ---`,
          exitLine,
          longRunningHint,
          riskyHint,
          fileInspectionHint,
        ].join('\n').trim());
      } catch (e) {
        const msg = e instanceof RuntimeBoxError ? e.reason : (e as Error).message;
        return textResult(`[RuntimeBox Error] ${msg}`, true);
      }
    },
  } as ToolDefinition;

  const pdfRenderTool: ToolDefinition = {
    name: 'pdf_render',
    label: 'Render PDF Pages',
    description: [
      'Render PDF pages into PNG/JPEG images so the AI can visually inspect scanned drawings, specifications, manuals, floor plans, forms, and other visual PDFs.',
      `In this project-scoped session it runs inside the Project Runtime Box for "${projectLabel}" and reads files directly from /workspace.`,
      'Use it when pdf_read/table extraction is insufficient or when the PDF must be understood as a visual document.',
    ].join(' '),
    promptSnippet: 'Render PDF pages to images, then inspect the output images with the read tool for vision analysis.',
    promptGuidelines: [
      'Prefer the harness-level pdf_view tool for visual PDF reading; it caches rendered pages internally and returns images directly to LLM vision without writing into the project folder.',
      'Use pdf_render only when you explicitly need image files written under /workspace for downstream project processing.',
      'Render only the pages needed. Use pages="1-4" for triage and increase DPI only when details are too small.',
      'In project sessions, do not use sandbox.run(workspace_path=...) just to render PDFs; this tool uses Runtime Box direct /workspace access.',
    ],
    parameters: PdfRenderParams,
    async execute(_toolCallId: string, params: {
      path: string;
      pages?: string;
      output_dir?: string;
      dpi?: number;
      format?: 'png' | 'jpeg';
    }) {
      const inputPath = params.path.startsWith('/') ? params.path : `/workspace/${params.path}`;
      const fmt = params.format || 'png';
      const dpi = params.dpi || 144;
      const pages = params.pages || '1-4';
      const outputDir = params.output_dir || `/workspace/.tower/pdf-renders/render-${Date.now()}`;
      const cmd = [
        "python3 - <<'PY'",
        'import fitz, os, re, sys, json',
        `pdf_path=${JSON.stringify(inputPath)}`,
        `pages_spec=${JSON.stringify(pages)}`,
        `output_dir=${JSON.stringify(outputDir)}`,
        `dpi=${JSON.stringify(dpi)}`,
        `fmt=${JSON.stringify(fmt)}`,
        'def parse_pages(spec, total):',
        '    out=[]',
        '    for part in str(spec).split(","):',
        '        part=part.strip()',
        '        if not part: continue',
        '        if "-" in part:',
        '            a,b=part.split("-",1); out.extend(range(int(a), int(b)+1))',
        '        else:',
        '            out.append(int(part))',
        '    seen=[]',
        '    for p in out:',
        '        if 1 <= p <= total and p not in seen: seen.append(p)',
        '    return seen[:12]',
        'doc=fitz.open(pdf_path)',
        'selected=parse_pages(pages_spec, doc.page_count)',
        'os.makedirs(output_dir, exist_ok=True)',
        'zoom=dpi/72',
        'mat=fitz.Matrix(zoom, zoom)',
        'paths=[]',
        'for pno in selected:',
        '    page=doc.load_page(pno-1)',
        '    pix=page.get_pixmap(matrix=mat, alpha=False)',
        '    ext="jpg" if fmt=="jpeg" else "png"',
        '    out=os.path.join(output_dir, f"page-{pno:03d}.{ext}")',
        '    pix.save(out)',
        '    paths.append(out)',
        'print(json.dumps({"pdf": pdf_path, "page_count": doc.page_count, "rendered": paths}, ensure_ascii=False, indent=2))',
        'PY',
      ].join('\n');

      try {
        await requireCurrentAgentExecutionAccess(ctx);
        const box = await getOrCreateBox(ctx.projectId, ctx.userId);
        const result = await execInBox({
          boxId: box.id,
          userId: ctx.userId,
          sessionId: ctx.sessionId,
          cmd,
          cwd: '/workspace',
          timeout_sec: 120,
        });
        const isError = result.exit_code !== 0;
        let hostPaths: string[] = [];
        if (!isError && result.stdout) {
          try {
            const parsed = JSON.parse(result.stdout);
            if (Array.isArray(parsed.rendered)) {
              hostPaths = parsed.rendered
                .map((p: string) => workspacePathToHostPath(p, ctx.projectRoot))
                .filter((p: string | null): p is string => !!p);
              recordRuntimeBoxTouchedFiles(ctx.sessionId, 'pdf_render', hostPaths);
            }
          } catch {
            // Keep raw stdout; rendering succeeded even if JSON parsing failed.
          }
        }
        return textResult([
          formatBanner(result.runtime_context),
          '--- PDF Render Result ---',
          result.stdout || '(no stdout)',
          hostPaths.length > 0 ? `\nReadable image paths for the read tool:\n${hostPaths.join('\n')}` : '',
          result.stderr ? `\n--- Stderr ---\n${result.stderr}` : '',
          isError ? `\n[Exit: ${result.exit_code}${result.timed_out ? ', TIMEOUT' : ''}${result.oom_killed ? ', OOM' : ''}]` : '',
          !isError ? '\nNext: call read on one or more readable image paths above to analyze visually.' : '',
        ].join('\n').trim(), isError);
      } catch (e) {
        const msg = e instanceof RuntimeBoxError ? e.reason : (e as Error).message;
        return textResult(`[RuntimeBox Error] ${msg}`, true);
      }
    },
  } as ToolDefinition;

  const serviceListTool: ToolDefinition = {
    name: 'service_list',
    label: 'Runtime Box Services',
    description: `List services registered in the Project Runtime Box for project "${projectLabel}". Shows name, port, status, command, and pinned state.`,
    promptSnippet: 'List currently registered Runtime Box services for this project.',
    promptGuidelines: [
      'Use service_list before starting a dev server to avoid duplicate services or port conflicts.',
      'Use service_list when you need to know what previewable/running processes exist for the current project.',
    ],
    parameters: ServiceListParams,
    async execute() {
      try {
        const services = await listServices(ctx.projectId);
        return textResult(`Project "${projectLabel}" services:\n${formatServiceList(services)}`);
      } catch (e) {
        return textResult(`[RuntimeBox Error] ${(e as Error).message}`, true);
      }
    },
  } as ToolDefinition;

  const serviceStartTool: ToolDefinition = {
    name: 'service_start',
    label: 'Start Runtime Box Service',
    description: [
      `Register a long-running service in the Project Runtime Box for project "${projectLabel}".`,
      'Use this for servers and watchers (npm run dev, uvicorn, node server.js) so Tower can track ports, logs, TTL, and pinned state.',
      'Starts the process inside the Runtime Box, stores PID/log metadata, and keeps it running until service_stop, TTL expiry, or box stop.',
    ].join(' '),
    promptSnippet: 'Start a long-running project service with port, TTL, logs, and optional pinning.',
    promptGuidelines: [
      'Use service_start instead of project_shell for dev servers, API servers, workers, and watch commands.',
      'Always provide a stable lowercase service name such as dev, api, web, worker.',
      'Pass cwd when the service command belongs to a subdirectory instead of writing cd ... && npm run dev into command.',
      'If pinned=true, provide a concise purpose explaining why it should stay up.',
      'After service_start, call service_logs if startup output or errors are needed.',
    ],
    parameters: ServiceStartParams,
    async execute(_toolCallId: string, params: {
      name: string;
      command: string;
      cwd?: string;
      port?: number;
      pinned?: boolean;
      purpose?: string;
      ttl_hours?: number;
    }) {
      if (params.pinned && !params.purpose?.trim()) {
        return textResult('[RuntimeBox Error] pinned 서비스에는 purpose가 필수입니다.', true);
      }
      return (workbenchExecuteTool.execute as any)(_toolCallId, {
        command: params.command,
        cwd: params.cwd,
        lifecycle: 'service',
        service: {
          name: params.name,
          port: params.port,
          pinned: params.pinned,
          purpose: params.purpose,
          ttlHours: params.ttl_hours,
        },
      }, undefined, undefined, undefined);
    },
  } as ToolDefinition;

  const serviceLogsTool: ToolDefinition = {
    name: 'service_logs',
    label: 'Runtime Box Service Logs',
    description: `Read recent logs for a Project Runtime Box service in project "${projectLabel}" by service_id from service_list.`,
    promptSnippet: 'Read logs from a running Runtime Box service.',
    promptGuidelines: [
      'Use service_logs after service_start to diagnose startup errors or confirm the dev server is ready.',
      'Use service_list first if you do not know the service_id.',
      'Prefer a small tail such as 80-200 lines unless debugging a long failure.',
    ],
    parameters: ServiceLogsParams,
    async execute(_toolCallId: string, params: { service_id: number; tail?: number }) {
      try {
        const logs = await readServiceLogs(params.service_id, params.tail ?? 100);
        return textResult(`Logs for service ${params.service_id}:\n${logs}`);
      } catch (e) {
        const msg = e instanceof RuntimeBoxError ? e.reason : (e as Error).message;
        return textResult(`[RuntimeBox Error] ${msg}`, true);
      }
    },
  } as ToolDefinition;

  const serviceStopTool: ToolDefinition = {
    name: 'service_stop',
    label: 'Stop Runtime Box Service',
    description: `Stop a registered Project Runtime Box service for project "${projectLabel}" by service_id from service_list.`,
    promptSnippet: 'Stop a registered Runtime Box service by id.',
    promptGuidelines: [
      'Use service_list first to find the service_id.',
      'Use service_stop to avoid orphaned dev servers or duplicate services.',
    ],
    parameters: ServiceStopParams,
    async execute(_toolCallId: string, params: { service_id: number }) {
      try {
        await stopService(params.service_id);
        return textResult(`Service ${params.service_id} stopped.`);
      } catch (e) {
        const msg = e instanceof RuntimeBoxError ? e.reason : (e as Error).message;
        return textResult(`[RuntimeBox Error] ${msg}`, true);
      }
    },
  } as ToolDefinition;

  const compatibilityEnabled = ctx.runtimeBoxCompatibilityEnabled !== false;
  // Ordinary Project shell access is no longer a Workbench beta rollout decision.
  // Every authorized Project enters the Project Environment resolver; that resolver
  // chooses canonical or legacy storage and fails closed when no executor is eligible.
  // The rollout flag remains limited to diagnostic/mutation management surfaces below.
  const unifiedShellTools = compatibilityEnabled
    ? [workbenchExecuteTool, projectDownloadTool, projectProcessTool, pdfRenderTool]
    : [workbenchExecuteTool, projectDownloadTool, projectProcessTool];
  if (!experimentalWorkbenchToolsVisible) return unifiedShellTools;
  return [
    ...unifiedShellTools,
    workbenchInspectTool,
    workbenchAcquisitionPreviewTool,
    workbenchPreviewTool,
    workbenchApplyTool,
    workbenchRuntimeRecreatePreviewTool,
    workbenchRuntimeRecreateApplyTool,
    workbenchJobListTool,
    workbenchJobGetTool,
    workbenchJobCancelTool,
    serviceListTool,
    ...(compatibilityEnabled ? [serviceStartTool, serviceLogsTool, serviceStopTool] : []),
  ];
}
