import { ensurePersonalSecretarySession } from './personal-session.js';
import { execute } from '../../db/pg-repo.js';
import { participatedSessionSql } from './session-scope.js';
import { queryOne } from '../../db/pg-repo.js';
import { canAccessSession } from '../pm/project-access.js';
import { isProjectMember } from '../pm/project-membership-manager.js';
import { secretariatStore, type Candidate, type SecretariatStore } from './store.js';
import { prepareProviders, safeCandidate } from './provider.js';

export class SecretariatAccessError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export async function activeRole(userId: number): Promise<string | null> {
  const user = await queryOne<{ role: string }>(`SELECT role FROM users WHERE id = $1 AND disabled = 0
    AND approval_status = 'active' AND role IN ('admin', 'operator', 'member')`, [userId]);
  return user?.role ?? null;
}
export async function canReadSource(userId: number, sessionId: string | null, projectId: string | null): Promise<boolean> {
  if (!sessionId || !projectId) return false;
  const role = await activeRole(userId);
  if (!role) return false;
  const source = await queryOne(`SELECT 1 FROM sessions s JOIN projects p ON p.id = s.project_id
    WHERE s.id = $1 AND ${participatedSessionSql('$2')} AND s.project_id = $3 AND COALESCE(s.archived, 0) = 0
      AND COALESCE(p.archived, 0) = 0 AND COALESCE(p.lifecycle_status, 'active') = 'active'`, [sessionId, userId, projectId]);
  if (!source) return false;
  // Operator has no blanket Project data grant. Reuse current membership and team/session audience checks.
  if (!await isProjectMember(projectId, userId, 'read')) return false;
  return (await canAccessSession(sessionId, userId, role)).allowed;
}

export interface SecretariatDependencies {
  store: SecretariatStore;
  activeRole: typeof activeRole;
  canReadSource: typeof canReadSource;
  prepare: typeof prepareProviders;
}
const defaults: SecretariatDependencies = { store: secretariatStore, activeRole, canReadSource, prepare: prepareProviders };

export function createSecretariatService(deps: SecretariatDependencies = defaults) {
  async function requireAccount(userId: number): Promise<void> {
    if (!await deps.activeRole(userId)) throw new SecretariatAccessError(403, 'Secretariat unavailable for this account');
  }
  async function withdrawInaccessible(userId: number) {
    const proposals = await deps.store.proposals(userId);
    const accessible = [];
    for (const proposal of proposals) {
      if (await deps.canReadSource(userId, proposal.sessionId, proposal.projectId)) accessible.push(proposal);
      else if (!proposal.readAt) await deps.store.read(userId, proposal.id);
    }
    return accessible;
  }
  async function allowedCandidate(userId: number, candidate: Candidate): Promise<boolean> {
    return safeCandidate(candidate) && await deps.store.sourceCurrent(userId, candidate)
      && await deps.canReadSource(userId, candidate.sessionId, candidate.projectId);
  }
  return {
    async inbox(userId: number) {
      await requireAccount(userId);
      const settings = await deps.store.settings(userId);
      const proposals = await withdrawInaccessible(userId);
      return { ...settings, pausedReason: settings.enabled && await deps.store.hasUnread(userId) ? 'unread_proposal' : null, proposals };
    },
    async setEnabled(userId: number, enabled: boolean) {
      await requireAccount(userId);
      return deps.store.setEnabled(userId, enabled);
    },
    async respond(userId: number, id: string, action: 'show' | 'skip' | 'today') {
      await requireAccount(userId);
      const proposal = (await withdrawInaccessible(userId)).find(p => p.id === id);
      if (!proposal) return false;
      return deps.store.respond(userId, id, action);
    },
    async read(userId: number, id: string) {
      await requireAccount(userId);
      // Always owner-scoped, even admin cannot acknowledge another person's inbox.
      return deps.store.read(userId, id);
    },
    async runUser(userId: number, manual = false): Promise<'skipped' | 'failed' | 'proposed'> {
      let claim: Awaited<ReturnType<SecretariatStore['claim']>> = null;
      let status: 'skipped' | 'failed' | 'proposed' = 'skipped';
      const diagnostic: Record<string, string | number> = { stage: 'gate', reason: 'gate_blocked', modelCalls: 0 };
      const started = Date.now();
      try {
        if (!await deps.activeRole(userId) || (!manual && !(await deps.store.settings(userId)).enabled)) return status;
        await withdrawInaccessible(userId);
        // Unread pause runs before claim, credential resolution, Jev, and Lite.
        if (await deps.store.hasUnread(userId)) return status;
        claim = await deps.store.claim(userId, manual);
        if (!claim || !await deps.store.stillAllowed(claim)) return status;
        diagnostic.stage = 'candidates'; diagnostic.reason = 'no_candidates';
        const candidates: Candidate[] = [];
        for (const candidate of await deps.store.candidates(userId)) {
          if (await allowedCandidate(userId, candidate)) candidates.push(candidate);
        }
        if (!candidates.length || !await deps.store.stillAllowed(claim)) return status;
        // Verify every Project connection before combining its bounded preview.
        const projectCandidates: Candidate[] = [];
        let provider: Awaited<ReturnType<typeof prepareProviders>> | undefined;
        for (const projectId of [...new Set(candidates.map(c => c.projectId))]) {
          try {
            const ready = await deps.prepare(userId, projectId);
            provider ??= ready;
            for (const c of candidates.filter(c => c.projectId === projectId)) {
              if (!await allowedCandidate(userId, c)) continue;
              const preview = (await deps.store.context(userId, c)).slice(-2).map(m => m.text.slice(0, 300)).join('\n');
              const enriched = { ...c, outcome: preview || c.outcome };
              if (safeCandidate(enriched)) projectCandidates.push(enriched);
            }
          } catch { diagnostic.unavailableProjects = Number(diagnostic.unavailableProjects || 0) + 1; diagnostic.reason = 'project_connection_unavailable'; }
        }
        if (!projectCandidates.length || !provider) return status;
        diagnostic.candidateCount = projectCandidates.length; diagnostic.stage = 'provider'; diagnostic.reason = 'provider_unavailable';

        if (!await deps.store.stillAllowed(claim)) return status;
        for (const candidate of projectCandidates) if (!await allowedCandidate(userId, candidate)) return status;
        diagnostic.stage = 'jev'; diagnostic.reason = 'jev_abstained'; diagnostic.modelCalls = 1;
        const choice = await provider.choose(projectCandidates, data => Object.assign(diagnostic, data));
        const chosen = projectCandidates.find(c => c.id === choice?.id);
        if (!choice || !chosen || !await deps.store.stillAllowed(claim) || !await allowedCandidate(userId, chosen)) return status;
        diagnostic.selectedScore = choice.score; diagnostic.stage = 'context'; diagnostic.reason = 'state_changed';
        const context = await deps.store.context(userId, chosen);
        if (!await deps.store.stillAllowed(claim) || !await allowedCandidate(userId, chosen)) return status;
        const history = (await withdrawInaccessible(userId)).filter(p => p.sessionId === chosen.sessionId).slice(0, 3)
          .map(p => ({ role: 'assistant', text: `Previous Secretariat proposal (${p.readAt ? 'acknowledged' : 'unread'}): ${p.title}\n${p.body.slice(0, 700)}` }));
        if (!await deps.store.stillAllowed(claim) || !await allowedCandidate(userId, chosen)) return status;
        const secretaryContext = await deps.store.secretaryContext(userId, chosen);
        if (!await deps.store.stillAllowed(claim) || !await allowedCandidate(userId, chosen)) return status;
        diagnostic.stage = 'lite'; diagnostic.reason = 'lite_silent'; diagnostic.modelCalls = 2;
        const selectedProvider = await deps.prepare(userId, chosen.projectId);
        const text = await selectedProvider.write(chosen, [...history, ...context, ...secretaryContext]);
        if (!text || !await deps.store.stillAllowed(claim) || !await allowedCandidate(userId, chosen)) return status;
        diagnostic.stage = 'store'; diagnostic.reason = 'duplicate_or_state_changed';
        if (await deps.store.insert(claim, chosen, manual ? { ...text, delivery: 'inbox' } : text)) { status = 'proposed';
          const conversationId = await ensurePersonalSecretarySession(userId);
          await execute('UPDATE sessions SET updated_at=NOW() WHERE id=$1 AND user_id=$2',[conversationId,userId]);
          diagnostic.reason = 'proposal_created'; diagnostic.delivery = text.delivery; }
        return status;
      } catch {
        // No placeholder proposal, logs containing credentials/provider bodies, notification, or retries.
        diagnostic.reason = 'stage_failed';
        status = 'failed';
        return status;
      } finally {
        if (claim) await deps.store.finish(claim, status, { ...diagnostic, elapsedMs: Date.now() - started }).catch(() => {});
        else if (!manual) await deps.store.defer(userId).catch(() => {});
      }
    },
  };
}
export const secretariatService = createSecretariatService();
