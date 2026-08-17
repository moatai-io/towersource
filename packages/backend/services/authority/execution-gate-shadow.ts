/**
 * Owns: shadow-mode Execution Gate classification/wrapping for tool dispatchers.
 * Public API: classifyToolExecutionAction, wrapToolsWithExecutionGateShadow.
 *
 * Shadow mode observes and logs most gate decisions. A narrow hard-stop exists for
 * direct tower-prod PM2 lifecycle commands because those restart the current user-facing
 * server and must never be executed autonomously by an AI tool call.
 */

import type { ExecutionActionClass, ExecutionGateInput, ExecutionGateResult, ExecutionOperationKind, ExecutionPolicy, ExecutionSurface } from './execution-gate.js';
import { evaluateExecutionGate } from './execution-gate.js';

export interface ExecutionGateShadowContext {
  userId?: number | null;
  userRole?: string | null;
  projectId?: string | null;
  projectMember?: boolean;
  projectRole?: 'owner' | 'member' | string | null;
  executionSurface?: ExecutionSurface;
  policy?: ExecutionPolicy | null;
  sessionId?: string;
  cwd?: string;
}

export interface ToolActionClassification {
  actionClass: ExecutionActionClass;
  target?: { type: string; id?: string; summary?: string; operation?: ExecutionOperationKind } | null;
  credentialAvailable?: boolean;
  credentialClass?: string | null;
  explicitConfirmation?: boolean;
  toolAvailable?: boolean;
  /** True for commands that shadow-mode must still block to protect the shared Tower host. */
  hardStopInShadow?: boolean;
  reason: string;
}

const READ_TOOLS = new Set([
  'read', 'grep', 'find', 'ls', 'excel_read', 'excel_query', 'excel_diff', 'pdf_read', 'pdf_view', 'cad_view',
  'WebFetch', 'WebSearch', 'memory_search', 'SharedTaskList', 'service_list', 'service_logs',
  'mcp__agent-worker__persistent_agent_list', 'mcp__agent-worker__persistent_agent_status',
  'mcp__tower-spawn__list_spawned_sessions', 'mcp__tower-spawn__get_spawned_response',
]);

const WRITE_TOOLS = new Set([
  'write', 'edit', 'NotebookEdit', 'MultiEdit', 'excel_write', 'TodoWrite', 'SharedTaskCreate', 'SharedTaskUpdate',
]);

const CREDENTIAL_ADMIN_TOOLS = new Set([
  'mcp__schedule__create_ai_schedule',
]);

function normalizeName(name: string): string {
  return String(name || '').trim();
}

function textParam(params: any, ...keys: string[]): string {
  for (const key of keys) {
    const value = params?.[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

function hasSecretReadPattern(command: string): boolean {
  const cmd = command.trim();
  return /(^|[;&|()\s])(env|printenv)(\s|$)/.test(cmd)
    || /\b(cat|less|more|tail|head)\b[^;&|]*\b(\.env|id_rsa|id_ed25519|\.pem|\.key|credentials\.json|token|secret)\b/i.test(cmd)
    || /\becho\s+\$[A-Z0-9_]*(TOKEN|SECRET|KEY|PASSWORD|PASS|CREDENTIAL)[A-Z0-9_]*/.test(cmd);
}

function hasInstallPattern(command: string): boolean {
  return /\b(npm|pnpm|yarn|bun)\s+(install|i|add)\b/.test(command)
    || /\b(pip|pip3)\s+install\b/.test(command)
    || /\buv\s+(add|pip\s+install)\b/.test(command)
    || /\bapt(-get)?\s+install\b/.test(command);
}

function isObserveOnlyOpsScript(command: string): boolean {
  const cmd = command.trim();
  if (/\bfleet-status\.sh\b/.test(cmd)) return true;
  if (/\bcheck-ai-capabilities\.sh\b/.test(cmd)) return true;
  if (/\bdeploy-verify-plus\.sh\b/.test(cmd)) return true;
  if (/\bdeploy-managed-skills\.sh\b/.test(cmd) && /\s--diff\b/.test(cmd)) return true;
  if (/\bfleet-remote-dirty-guard\.sh\b/.test(cmd) && !/\s--apply\b/.test(cmd)) return true;
  return false;
}

function hasDeployPattern(command: string): boolean {
  return /\b(fleet-deploy|deploy|release)\b/.test(command)
    || /\bpm2\s+(restart|reload|start|stop|delete)\b/.test(command)
    || /\bgit\s+push\b/.test(command)
    || /commit-and-tag-version/.test(command)
    || /scripts\/fleet\/fleet-release\.sh/.test(command)
    || /\/fleet\s+deploy\b/.test(command);
}

function hasDirectTowerProdPm2LifecyclePattern(command: string): boolean {
  const lifecycle = String.raw`(?:restart|reload|start|stop|delete)`;
  const separator = String.raw`(?:^|[;&|()\n]\s*)`;
  const directPm2 = new RegExp(`${separator}(?:sudo\\s+)?pm2\\s+${lifecycle}\\s+(?:tower-prod|0|all)(?:\\s|$)`);
  const namedTowerProdStart = new RegExp(`${separator}(?:sudo\\s+)?pm2\\s+start\\b[^;&|\n]*\\s--name\\s+tower-prod(?:\\s|$)`);
  return directPm2.test(command) || namedTowerProdStart.test(command);
}

function hasCustomerVmPattern(command: string): boolean {
  return /(^|[;&|()\s])ssh\s+/.test(command)
    || /scripts\/fleet\//.test(command)
    || /deploy-managed-skills\.sh/.test(command)
    || /\bfleet-status\.sh\b/.test(command)
    || /\b(self-hosted server|self-hosted-server)\b/i.test(command);
}

function hasContainerPattern(command: string): boolean {
  return /(^|[;&|()\s])(docker|podman)\s+/.test(command)
    || /\bkubectl\s+/.test(command);
}

function hasCrossProjectPattern(command: string): boolean {
  return /--all-projects\b/.test(command)
    || /workspace\/projects\/\*/.test(command)
    || /find\s+[^;&|]*workspace\/projects\b/.test(command);
}

function hasWritePattern(command: string): boolean {
  return /\b(mkdir|touch|mv|cp|rm|tee|ln|install|rsync|chmod|chown|tar|unzip|zip|gunzip)\b/.test(command)
    || /(?:^|[^0-9&])(>>?|\|\s*tee\b)/.test(command);
}

function inferOperationKind(command: string): ExecutionOperationKind {
  const cmd = command.trim();
  if (/\b(pm2|docker|podman|kubectl)\s+(status|list|ls|ps)\b/.test(cmd) || /\bfleet-status\.sh\b/.test(cmd)) return 'status';
  if (/\b(pm2|docker|podman|kubectl)\s+(logs|log)\b/.test(cmd) || /\btail\b[^;&|]*\blog/.test(cmd)) return 'logs';
  if (isObserveOnlyOpsScript(cmd)) return 'inspect';
  if (/\b(inspect|describe|get)\b/.test(cmd)) return 'inspect';
  if (/\b(exec|ssh)\b/.test(cmd)) return 'exec';
  if (/\b(sync|rsync|scp)\b/.test(cmd) || /deploy-managed-skills\.sh/.test(cmd) || (/\bfleet-remote-dirty-guard\.sh\b/.test(cmd) && /\s--apply\b/.test(cmd))) return 'sync';
  if (/\b(restart|reload)\b/.test(cmd)) return 'restart';
  if (/\b(deploy|release|fleet-deploy)\b/.test(cmd) || /\bgit\s+push\b/.test(cmd)) return 'deploy';
  if (/\b(delete|remove|rm|stop)\b/.test(cmd)) return 'delete';
  if (hasWritePattern(cmd)) return 'write';
  return 'unknown';
}

function redactCommandSummary(command: string): string {
  return command
    .replace(/(Authorization:\s*Bearer\s+)[^\s'";|&]+/gi, '$1[REDACTED]')
    .replace(/\b(Bearer\s+)[^\s'";|&]+/gi, '$1[REDACTED]')
    .replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|KEY|CREDENTIAL)[A-Z0-9_]*\s*=\s*)([^\s'";|&]+)/g, '$1[REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '[REDACTED_OPENAI_KEY]')
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{12,})\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\b(AIza[0-9A-Za-z_-]{20,})\b/g, '[REDACTED_GOOGLE_KEY]')
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g, '[REDACTED_SLACK_TOKEN]')
    .replace(/\b([A-Za-z0-9+/]{32,}={0,2})\b/g, '[REDACTED_LONG_SECRET]');
}

function summarizeCommand(command: string): string {
  return redactCommandSummary(command).slice(0, 160);
}

function commandTarget(command: string): { type: string; summary: string; operation?: ExecutionOperationKind } {
  const operation = inferOperationKind(command);
  const sshMatch = command.match(/(^|[;&|()\s])ssh\s+([^\s'";|&]+)/);
  if (sshMatch?.[2]) return { type: 'self-hosted-server', summary: redactCommandSummary(sshMatch[2]).slice(0, 160), operation };
  if (/docker|podman|kubectl/.test(command)) return { type: 'container', summary: summarizeCommand(command), operation };
  if (/fleet|ssh|deploy-managed-skills/.test(command)) return { type: 'self-hosted-server', summary: summarizeCommand(command), operation };
  return { type: 'command', summary: summarizeCommand(command), operation };
}

export function classifyShellCommand(command: string): ToolActionClassification {
  const cmd = command.trim();
  if (hasSecretReadPattern(cmd)) {
    return { actionClass: 'secret-read', target: commandTarget(cmd), reason: 'shell command may reveal secret values' };
  }
  if (isObserveOnlyOpsScript(cmd)) {
    return {
      actionClass: 'self-hosted-server',
      target: commandTarget(cmd),
      credentialAvailable: undefined,
      reason: 'shell command runs observe-only self-hosted server/fleet diagnostics',
    };
  }
  if (hasDeployPattern(cmd)) {
    const hardStopInShadow = hasDirectTowerProdPm2LifecyclePattern(cmd);
    return {
      actionClass: 'deploy',
      target: commandTarget(cmd),
      hardStopInShadow,
      reason: hardStopInShadow
        ? 'direct tower-prod PM2 lifecycle command requires explicit human-run safe path'
        : 'shell command matches deploy/release/restart pattern',
    };
  }
  if (hasContainerPattern(cmd)) {
    return { actionClass: 'container', target: commandTarget(cmd), reason: 'shell command uses container tooling' };
  }
  if (hasCustomerVmPattern(cmd)) {
    return {
      actionClass: 'self-hosted-server',
      target: commandTarget(cmd),
      credentialAvailable: undefined,
      reason: 'shell command appears to target self-hosted server/fleet tooling',
    };
  }
  if (hasCrossProjectPattern(cmd)) {
    return { actionClass: 'cross-project', target: commandTarget(cmd), reason: 'shell command appears to span multiple projects' };
  }
  if (hasInstallPattern(cmd)) {
    return { actionClass: 'install-tool', target: commandTarget(cmd), reason: 'shell command installs project/runtime tooling' };
  }
  if (hasWritePattern(cmd)) {
    return { actionClass: 'write', target: commandTarget(cmd), reason: 'shell command mutates filesystem or permissions' };
  }
  return { actionClass: 'read', target: commandTarget(cmd), reason: 'shell command classified as read/light execution' };
}

export function classifyToolExecutionAction(toolName: string, params: any): ToolActionClassification {
  const name = normalizeName(toolName);
  if (name === 'bash') return classifyShellCommand(textParam(params, 'command'));
  if (name === 'project_shell') return classifyShellCommand(textParam(params, 'cmd', 'command'));
  if (name === 'workbench_tool_inspect') return { actionClass: 'read', target: { type: 'workbench-tools', operation: 'inspect' }, reason: 'tool inspects experimental Workbench tool state' };
  if (name === 'workbench_tool_preview_change') return { actionClass: 'write', target: { type: 'workbench-tools', operation: 'write' }, reason: 'tool creates a durable Workbench change intent' };
  if (name === 'workbench_tool_apply_change') return { actionClass: 'install-tool', target: { type: 'workbench-tools', operation: 'write' }, explicitConfirmation: params?.confirmed === true, reason: 'tool mutates the experimental Workbench tool environment' };
  if (READ_TOOLS.has(name)) return { actionClass: 'read', reason: `tool ${name} is read/diagnostic` };
  if (WRITE_TOOLS.has(name)) return { actionClass: 'write', reason: `tool ${name} mutates project artifacts` };
  if (name === 'publish_site' || name === 'mcp__sandbox__tool_update_visibility') {
    return { actionClass: 'deploy', reason: `tool ${name} publishes or changes external exposure` };
  }
  if (name.startsWith('service_start') || name === 'service_stop') {
    return { actionClass: 'container', reason: `tool ${name} changes runtime service state` };
  }
  if (CREDENTIAL_ADMIN_TOOLS.has(name)) {
    return { actionClass: 'credential-admin', reason: `tool ${name} changes scheduled/system authority` };
  }
  if (name.startsWith('mcp__sandbox__tool_')) {
    return { actionClass: 'container', reason: `tool ${name} manages long-running tool containers` };
  }
  if (name.startsWith('mcp__tower-spawn__send') || name === 'mcp__tower-spawn__spawn_session') {
    return { actionClass: 'write', reason: `tool ${name} sends or creates session messages` };
  }
  return { actionClass: 'read', reason: `tool ${name} has no high-impact classifier yet` };
}

export function shouldLogExecutionGateShadow(result: ExecutionGateResult, classification: ToolActionClassification): boolean {
  return result.highImpact
    || result.decision !== 'allow'
    || classification.actionClass !== 'read';
}

export function buildExecutionGateShadowInput(
  ctx: ExecutionGateShadowContext,
  classification: ToolActionClassification,
): ExecutionGateInput {
  return {
    userId: ctx.userId ?? undefined,
    userRole: ctx.userRole ?? undefined,
    projectId: ctx.projectId ?? undefined,
    projectMember: ctx.projectMember ?? (ctx.projectId ? true : undefined),
    projectRole: ctx.projectRole ?? (ctx.projectId ? 'member' : undefined),
    actionClass: classification.actionClass,
    target: classification.target,
    credentialAvailable: classification.credentialAvailable,
    credentialClass: classification.credentialClass,
    toolAvailable: classification.toolAvailable,
    executionSurface: ctx.executionSurface ?? 'project-runbox',
    policy: ctx.policy,
    explicitConfirmation: classification.explicitConfirmation,
    auditAvailable: true,
  };
}

export function observeExecutionGateShadow(
  ctx: ExecutionGateShadowContext,
  toolName: string,
  params: any,
): { classification: ToolActionClassification; result: ExecutionGateResult } {
  const classification = classifyToolExecutionAction(toolName, params);
  const result = evaluateExecutionGate(buildExecutionGateShadowInput(ctx, classification));
  if (shouldLogExecutionGateShadow(result, classification)) {
    const project = ctx.projectId || 'none';
    const session = ctx.sessionId ? ctx.sessionId.slice(0, 8) : 'none';
    const target = classification.target?.summary || classification.target?.id || classification.target?.type || 'none';
    // eslint-disable-next-line no-console
    console.info(
      `[ExecutionGate:shadow] decision=${result.decision} action=${classification.actionClass} tool=${toolName} role=${ctx.userRole || 'unknown'} project=${project} session=${session} target=${JSON.stringify(target)} reason=${classification.reason}`,
    );
  }
  return { classification, result };
}

export function shouldHardStopExecutionGateShadow(classification: ToolActionClassification, result: ExecutionGateResult): boolean {
  return classification.hardStopInShadow === true && result.decision !== 'allow';
}

function buildHardStopMessage(classification: ToolActionClassification, result: ExecutionGateResult): string {
  const target = classification.target?.summary || classification.target?.id || classification.target?.type || 'unknown target';
  return [
    'ExecutionGate blocked a direct tower-prod lifecycle command.',
    `decision=${result.decision}`,
    `target=${target}`,
    'Use the explicit prod-restart safe path from an operator-controlled flow instead of direct pm2 restart/reload/start/stop/delete.',
  ].join(' ');
}

/** Wrap Pi-style tools in shadow observation. Mostly observes; hard-stops direct tower-prod PM2 lifecycle commands. */
export function wrapToolsWithExecutionGateShadow<T extends { name?: string; execute?: (...args: any[]) => any }>(
  tools: T[],
  ctx: ExecutionGateShadowContext,
): T[] {
  return tools.map(tool => {
    if (!tool?.execute) return tool;
    const origExecute = tool.execute;
    const toolName = tool.name || 'unknown';
    return {
      ...tool,
      execute: async (...execArgs: any[]) => {
        const params = execArgs[1] ?? execArgs[0] ?? {};
        try {
          const observed = observeExecutionGateShadow(ctx, toolName, params);
          if (shouldHardStopExecutionGateShadow(observed.classification, observed.result)) {
            throw new Error(buildHardStopMessage(observed.classification, observed.result));
          }
        } catch (err) {
          if (err instanceof Error && err.message.startsWith('ExecutionGate blocked ')) {
            throw err;
          }
          // Shadow observation failures must never break execution. Intentional hard-stops above are re-thrown.
          // eslint-disable-next-line no-console
          console.warn('[ExecutionGate:shadow] observation failed:', err);
        }
        return origExecute.call(tool, ...execArgs);
      },
    } as T;
  });
}
