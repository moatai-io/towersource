export interface DockerInspectResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface VerifiedContainerIdentity {
  containerId: string;
  containerName: string;
  boxId: number;
  projectId: string;
}

export interface ObservedContainerIdentity {
  containerId?: string;
  containerName?: string;
  boxId?: string;
  projectId?: string;
}

export type ContainerObservation =
  | { kind: 'running'; identity: VerifiedContainerIdentity }
  | { kind: 'not_running'; identity: VerifiedContainerIdentity }
  | { kind: 'not_found' }
  | { kind: 'inspection_unknown'; error: string }
  | { kind: 'identity_mismatch'; observed: ObservedContainerIdentity };

interface DockerInspectPayload {
  Id?: unknown;
  Name?: unknown;
  Config?: { Labels?: Record<string, unknown> | null } | null;
  State?: { Running?: unknown } | null;
}

const NOT_FOUND = /\b(?:no such (?:object|container)|not found)\b/i;

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function summarizeFailure(result: DockerInspectResult): string {
  if (result.timedOut) return 'docker inspect timed out';
  return (result.stderr || result.stdout || `docker inspect exited ${result.exitCode}`).trim().slice(0, 500);
}

/** Mutation-free Docker observation. Only exact labels confer Runtime Box ownership. */
export async function observeRuntimeBoxContainer(input: {
  containerRef: string;
  expectedBoxId: number;
  expectedProjectId: string;
  inspect: (containerRef: string) => Promise<DockerInspectResult>;
}): Promise<ContainerObservation> {
  let result: DockerInspectResult;
  try {
    result = await input.inspect(input.containerRef);
  } catch (error) {
    return { kind: 'inspection_unknown', error: String((error as Error)?.message ?? error).slice(0, 500) };
  }

  if (result.exitCode !== 0) {
    const failure = summarizeFailure(result);
    if (!result.timedOut && NOT_FOUND.test(failure)) return { kind: 'not_found' };
    return { kind: 'inspection_unknown', error: failure };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { kind: 'inspection_unknown', error: 'docker inspect returned malformed JSON' };
  }
  const item = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] as DockerInspectPayload : undefined;
  const labels = item?.Config?.Labels;
  const observed: ObservedContainerIdentity = {
    containerId: text(item?.Id),
    containerName: text(item?.Name)?.replace(/^\//, ''),
    boxId: text(labels?.['tower.box.id']),
    projectId: text(labels?.['tower.project.id']),
  };
  const running = item?.State?.Running;
  if (!observed.containerId || !observed.containerName || typeof running !== 'boolean') {
    return { kind: 'inspection_unknown', error: 'docker inspect response omitted required identity or state' };
  }
  if (observed.boxId !== String(input.expectedBoxId) || observed.projectId !== input.expectedProjectId) {
    return { kind: 'identity_mismatch', observed };
  }
  const identity: VerifiedContainerIdentity = {
    containerId: observed.containerId,
    containerName: observed.containerName,
    boxId: input.expectedBoxId,
    projectId: input.expectedProjectId,
  };
  return running ? { kind: 'running', identity } : { kind: 'not_running', identity };
}
