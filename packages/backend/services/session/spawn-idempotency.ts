/**
 * Owns: stable request identity for session-spawn retry deduplication.
 * Public API: buildSpawnRequestFingerprint, SPAWN_DEDUPE_WINDOW_SECONDS.
 */

import { createHash } from 'node:crypto';
import type { SpawnRequest } from './spawn-rpc.js';

/** Transport recovery normally repeats within seconds; two minutes covers delayed auto-continuation. */
export const SPAWN_DEDUPE_WINDOW_SECONDS = 120;

function normalizeText(value: string | undefined): string {
  return (value ?? '').trim().replace(/\r\n/g, '\n');
}

/**
 * Hash all child-creation semantics except caller identity, which is scoped by
 * the parent-session lookup and advisory lock in spawn-rpc.
 */
export function buildSpawnRequestFingerprint(req: SpawnRequest): string {
  const semanticRequest = {
    // rootTurnId/operationId are transport/execution identity, not semantic
    // content. Exact operation retries use operation_id; legacy callers retain
    // the bounded semantic fingerprint fallback below.
    name: normalizeText(req.name),
    prompt: normalizeText(req.prompt),
    contextSummary: normalizeText(req.contextSummary),
    engine: req.engine ?? null,
    model: req.model ?? null,
    effort: req.effort ?? null,
    modelPolicyId: req.modelPolicyId ?? null,
    modelPolicyRevision: req.modelPolicyRevision ?? null,
    requestedEffort: req.requestedEffort ?? null,
    effortDowngraded: req.effortDowngraded ?? false,
    projectId: req.projectId === undefined ? '__inherit__' : req.projectId,
    onComplete: {
      mode: req.onComplete?.mode ?? 'inject-and-wake',
      webhookUrl: req.onComplete?.webhookUrl ?? null,
      injectTemplate: req.onComplete?.injectTemplate ?? null,
      agentReport: req.onComplete?.agentReport ?? null,
    },
  };
  return createHash('sha256').update(JSON.stringify(semanticRequest)).digest('hex');
}
