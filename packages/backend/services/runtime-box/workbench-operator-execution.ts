import os from 'node:os';
import path from 'node:path';
import type { WorkbenchExecutionRequest } from './workbench-execution-broker.js';

export interface OperatorExecutionResolution {
  request: WorkbenchExecutionRequest;
  operatorPlane: boolean;
  hostCwd?: string;
  logicalCwd?: string;
  credentialMode: 'none' | 'required-only';
}

interface OperatorRoot {
  hostRoot: string;
  logicalRoot: string;
}

function configuredRoots(env: NodeJS.ProcessEnv): OperatorRoot[] {
  const home = path.resolve(env.HOME?.trim() || os.homedir());
  const towerRoot = path.resolve(env.TOWER_OPERATOR_TOWER_SOURCE_ROOT?.trim() || path.join(home, 'tower'));
  const workspaceRoot = path.resolve(env.TOWER_OPERATOR_WORKSPACE_ROOT?.trim() || path.join(home, 'workspace'));
  return [
    { hostRoot: towerRoot, logicalRoot: '/workspace/tower' },
    { hostRoot: workspaceRoot, logicalRoot: '/workspace/workspace' },
  ];
}

function under(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/**
 * Convert an admin/operator host cwd into the stable Operator Workbench projection.
 * Ordinary Project commands remain unchanged and every non-operator host escape fails closed.
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
    if (!['admin', 'operator'].includes(input.actorRole ?? '')) {
      throw new Error('OPERATOR_PLANE_ROLE_REQUIRED: Tower source and organization workspace projections require Admin or Operator authority');
    }
    return { request: input.request, operatorPlane: true, logicalCwd: requested, credentialMode: 'none' };
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

  if (!['admin', 'operator'].includes(input.actorRole ?? '')) {
    throw new Error('PROJECT_CWD_OUTSIDE_WORKSPACE: host paths outside the current Project require Organization Admin or Operator authority');
  }

  const match = configuredRoots(input.env ?? process.env).find(root => under(root.hostRoot, hostCwd));
  if (!match) {
    throw new Error('OPERATOR_CWD_NOT_ALLOWLISTED: admin host cwd must be inside Tower source or the organization workspace');
  }
  const relative = path.relative(match.hostRoot, hostCwd).split(path.sep).join('/');
  const logicalCwd = relative ? `${match.logicalRoot}/${relative}` : match.logicalRoot;
  return {
    request: { ...input.request, cwd: logicalCwd, env: input.request.env ? { ...input.request.env } : undefined },
    operatorPlane: true,
    hostCwd,
    logicalCwd,
    credentialMode: 'none',
  };
}
