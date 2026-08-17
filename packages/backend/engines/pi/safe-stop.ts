export type PiSafeStopWaitingFor = 'active_tool' | 'engine_boundary';

export type PiSafeStopRequestDisposition =
  | { accepted: false; reason: 'not_running' }
  | { accepted: true; waitingFor: PiSafeStopWaitingFor; duplicate: boolean };

export function classifyPiSafeStopRequest(input: {
  isRunning: boolean;
  promptActive: boolean;
  runPhase?: string;
  alreadyRequested: boolean;
}): PiSafeStopRequestDisposition {
  if (!input.isRunning || !input.promptActive) {
    return { accepted: false, reason: 'not_running' };
  }
  return {
    accepted: true,
    waitingFor: input.runPhase === 'tool_running' ? 'active_tool' : 'engine_boundary',
    duplicate: input.alreadyRequested,
  };
}

/**
 * Safe Stop owns only the Pi inference/tool-call boundary. A service previously
 * registered by service_start has a separate lifecycle and is intentionally not
 * represented here; finishing the service_start tool is the safe boundary.
 */
export function shouldStopPiAtToolBoundary(input: {
  toolRunDepth: number;
  safeStopRequested: boolean;
  abortRequested: boolean;
}): boolean {
  return input.toolRunDepth === 0 && input.safeStopRequested && !input.abortRequested;
}
