import crypto from 'node:crypto';
import { resolveProjectWorkspaceFile, readProjectWorkspaceFileBytes } from '../services/project-environment/project-workspace-files.js';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { evaluateWithOpenRouterJev } from '../services/decision/openrouter-jev-adapter.js';
import { parseDecisionSpec } from '../services/decision/decision-spec.js';
import { resolveGatewayProfileClient } from '../services/gateway-profile/gateway-profile-client.js';

const requestSchema = Type.Union([
  Type.Object({ state: Type.Any(), questions: Type.Record(Type.String(), Type.Any()), timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 10_000 })) }, { additionalProperties: false }),
  Type.Object({ requestPath: Type.String({ minLength: 1, maxLength: 2000 }) }, { additionalProperties: false }),
]);

const SECRET_FIELD_NAME = /^(?:secret|secret[_-]?value|password|passwd|token|access[_-]?token|refresh[_-]?token|auth[_-]?token|api[_-]?key|apikey|private[_-]?key|client[_-]?secret|credential[_-]?(?:value|json|bundle|content))$/i;
const SECRET_ENV_NAME = /(?:^|_)(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|REFRESH_TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|CLIENT_SECRET|SECRET)$/;

function isSecretFieldName(key: string): boolean {
  return SECRET_FIELD_NAME.test(key) || SECRET_ENV_NAME.test(key);
}

function containsSecretKey(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsSecretKey);
  return Object.entries(value).some(([key, child]) => isSecretFieldName(key) || containsSecretKey(child));
}

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], details: undefined };
}

export function createDecisionEvaluateTool(ctx: { projectId?: string; userId?: number; sessionId: string }): ToolDefinition {
  return {
    name: 'decision_evaluate',
    label: 'Decision Evaluate',
    description: 'Run a fast structured Choice, Noul, or Score decision for routing, planning, delegation, drift detection, or verification. The result is advisory evidence only and never grants permission for external writes, destructive actions, credential access, or approvals.',
    promptSnippet: 'Use decision_evaluate for bounded fast routing or verification decisions. Prefer compact state and never treat its output as authorization.',
    parameters: requestSchema,
    execute: async (_toolCallId, params, signal) => {
      if (!ctx.projectId || !ctx.userId) return result({ error: 'decision.evaluate requires an authenticated Project session', code: 'DECISION_CONTEXT_REQUIRED' });
      let input: { state: unknown; questions: Record<string, unknown>; timeoutMs?: number };
      let requestEvidence: { requestPath: string; sha256: string } | undefined;
      try {
        const raw = params as Record<string, unknown>;
        if ('requestPath' in raw) {
          if (Object.keys(raw).length !== 1 || typeof raw.requestPath !== 'string') throw new Error('Invalid file request');
          const reference = await resolveProjectWorkspaceFile({ projectId: ctx.projectId, relativePath: raw.requestPath });
          const { bytes } = await readProjectWorkspaceFileBytes({ reference, actorUserId: ctx.userId, maxBytes: 150_000 });
          const parsed = JSON.parse(bytes.toString('utf8'));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('state' in parsed) || !parsed.questions || typeof parsed.questions !== 'object' || Array.isArray(parsed.questions) || Object.keys(parsed).some(key => !['state', 'questions', 'timeoutMs'].includes(key))) throw new Error('Invalid request JSON');
          input = parsed;
          requestEvidence = { requestPath: raw.requestPath, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
        } else input = raw as typeof input;
        if (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 10_000)) throw new Error('Invalid timeout');
      } catch {
        return result({ error: 'Cannot read or validate Project decision request', code: 'DECISION_REQUEST_FILE_INVALID' });
      }
      if (containsSecretKey(input.state) || containsSecretKey(input.questions)) {
        return result({ error: 'Decision state and questions must not contain secret-like fields', code: 'DECISION_SECRET_FIELD' });
      }
      try {
        const spec = parseDecisionSpec({
          schemaVersion: 1,
          id: 'tower.raw-decision',
          revision: 1,
          purpose: 'Evaluate a caller-supplied bounded Tower decision.',
          mode: 'advisory',
          state: { maxBytes: 100_000, allowedData: ['project', 'session'], prohibitedFields: ['secret', 'token', 'password', 'credential'] },
          questions: input.questions,
          policy: { minConfidence: 0, confidenceQuestionIds: [], onAbstain: 'observe_only' },
          tags: ['raw', 'pi-tool'],
        });
        const gateway = await resolveGatewayProfileClient({ actorUserId: ctx.userId, projectId: ctx.projectId });
        const abort = new AbortController();
        const onAbort = () => abort.abort();
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
          const decision = await evaluateWithOpenRouterJev(spec, input.state, { apiKey: gateway.apiKey, baseUrl: gateway.baseUrl, timeoutMs: input.timeoutMs, fetchImpl: async (url, init) => fetch(url, { ...init, signal: abort.signal }) });
          return result({ ...decision, ...(requestEvidence ? { requestEvidence } : {}), caller: { projectId: ctx.projectId, sessionId: ctx.sessionId } });
        } finally { signal?.removeEventListener('abort', onAbort); }
      } catch (error) {
        return result({ error: error instanceof Error ? error.message : 'Decision evaluation failed', code: (error as { code?: string })?.code ?? 'DECISION_EVALUATE_FAILED' });
      }
    },
  } as ToolDefinition;
}
