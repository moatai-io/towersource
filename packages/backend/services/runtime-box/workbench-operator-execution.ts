import path from 'node:path';
import type { WorkbenchExecutionRequest } from '../execution/execution-broker.js';

export interface OperatorExecutionResolution {
  request: WorkbenchExecutionRequest;
  operatorPlane: false;
  hostCwd?: string;
  logicalCwd?: string;
  credentialMode: 'required-only';
}

function under(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/**
 * Keep Project execution inside its Project root.
 *
 * Operator access is assembled separately as native host bash for an
 * admin/operator using an Agent whose current policy enables it. Project
 * Workers never project Tower source or the organization workspace.
 */
export function resolveOperatorExecution(input: {
  request: WorkbenchExecutionRequest;
  actorRole?: string;
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
}): OperatorExecutionResolution {
  const requested = input.request.cwd?.trim();
  const operatorLogicalCwd = requested === '/workspace/tower'
    || requested?.startsWith('/workspace/tower/')
    || requested === '/workspace/workspace'
    || requested?.startsWith('/workspace/workspace/');
  if (operatorLogicalCwd) {
    throw new Error('OPERATOR_ACCESS_REQUIRED: enable Operator access for this Agent to use the native Operator execution environment');
  }
  if (!requested || !path.isAbsolute(requested) || requested === '/workspace' || requested.startsWith('/workspace/')) {
    return { request: input.request, operatorPlane: false, credentialMode: 'required-only' };
  }

  const projectRoot = input.projectRoot ? path.resolve(input.projectRoot) : undefined;
  const hostCwd = path.resolve(requested);
  if (projectRoot && under(projectRoot, hostCwd)) {
    const relative = path.relative(projectRoot, hostCwd).split(path.sep).join('/');
    return {
      request: { ...input.request, cwd: relative ? `/workspace/${relative}` : '/workspace' },
      operatorPlane: false,
      hostCwd,
      logicalCwd: relative ? `/workspace/${relative}` : '/workspace',
      credentialMode: 'required-only',
    };
  }

  throw new Error('PROJECT_CWD_OUTSIDE_WORKSPACE: paths outside the current Project require Operator access on this Agent. An admin/operator can enable it in Agent settings; retry on the next turn. If already enabled, report the execution-authority mismatch instead of assuming the setting was not saved.');
}
