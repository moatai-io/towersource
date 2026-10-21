import type { ProjectConnectionDiagnostics } from './connection-reliability.js';

/** Deployment evidence evaluator, not a second resolver or permission system.
 * Callers must collect evidence with the existing diagnostic under each exact
 * project/user context. Provider/process evidence must be collected separately.
 */
export interface ConnectionContinuityCheck {
  projectId: string;
  userId: number;
  connectionId: string;
  expectedAccess: 'allowed' | 'denied';
  // Actual execution authorization result, not inventory visibility.
  access: 'allowed' | 'denied' | 'unknown';
  diagnostics?: ProjectConnectionDiagnostics;
  processInjection: 'pass' | 'fail' | 'unknown';
  providerRead: 'pass' | 'fail' | 'unknown';
}

export function evaluateConnectionContinuity(checks: ConnectionContinuityCheck[]) {
  const results = checks.map(check => {
    const identity = { projectId: check.projectId, userId: check.userId, connectionId: check.connectionId };
    let reason: string;
    if (check.access === 'unknown') reason = 'AccessUnverified';
    else if (check.access !== check.expectedAccess) reason = 'AccessChanged';
    else if (check.expectedAccess === 'denied') reason = 'PreservedDenial';
    else {
      const diagnostic = check.diagnostics?.connections.find(row => row.connectionId === check.connectionId);
      if (!check.diagnostics?.inventoryComplete || !diagnostic) reason = 'MissingConnectionEvidence';
      else if (!diagnostic.stages.some(stage => stage.stage === 'materialization' && stage.status === 'pass')) reason = 'MaterializationUnverified';
      else if (check.processInjection !== 'pass') reason = 'ProcessInjectionUnverified';
      else if (check.providerRead !== 'pass') reason = 'ProviderReadUnverified';
      else reason = 'PreservedAccess';
    }
    return { ...identity, pass: reason === 'PreservedAccess' || reason === 'PreservedDenial', reason };
  });
  return { complete: results.length > 0 && results.every(row => row.pass), results };
}
