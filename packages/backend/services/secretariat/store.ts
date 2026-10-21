import { participatedSessionSql, sessionCandidatesSql } from './session-scope.js';
import { randomUUID } from 'node:crypto';
import { query, queryOne, execute, transaction, withClient } from '../../db/pg-repo.js';

export interface SecretariatProposal {
  id: string; title: string; body: string; createdAt: string; readAt: string | null; shownAt?: string | null; delivery?: 'popup' | 'inbox';
  sessionId: string | null; projectId: string | null;
}
export interface Candidate {
  id: string; sourceKey: string; title: string; outcome: string; updatedAt: string;
  sessionId: string; projectId: string;
}
export interface Claim { userId: number; token: string; generation: number; manual?: boolean }
export type RunStatus = 'skipped' | 'failed' | 'proposed';
export const INTERVAL_MS = 60 * 60 * 1000;

function iso(value: string | Date): string { return new Date(value).toISOString(); }

export const secretariatStore = {
  async settings(userId: number): Promise<{ enabled: boolean }> {
    const row = await queryOne<{ enabled: boolean }>('SELECT enabled FROM secretariat_settings WHERE user_id = $1', [userId]);
    return { enabled: row?.enabled === true };
  },
  async setEnabled(userId: number, enabled: boolean): Promise<{ enabled: boolean }> {
    await execute(`INSERT INTO secretariat_settings (user_id, enabled) VALUES ($1, $2)
      ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled,
      generation = secretariat_settings.generation + 1, updated_at = NOW()`, [userId, enabled]);
    return { enabled };
  },
  async proposals(userId: number): Promise<SecretariatProposal[]> {
    const rows = await query<any>(`SELECT id, title, body, created_at, read_at, session_id, project_id, shown_at, delivery
      FROM secretariat_proposals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [userId]);
    return rows.map(row => ({ id: row.id, title: row.title, body: row.body,
      createdAt: iso(row.created_at), readAt: row.read_at ? iso(row.read_at) : null, delivery: row.delivery || 'popup', shownAt: row.shown_at ? iso(row.shown_at) : null,
      sessionId: row.session_id, projectId: row.project_id }));
  },
  async hasUnread(userId: number): Promise<boolean> {
    return !!await queryOne('SELECT 1 FROM secretariat_proposals WHERE user_id = $1 AND read_at IS NULL LIMIT 1', [userId]);
  },
  async read(userId: number, proposalId: string): Promise<boolean> {
    const result = await execute(`UPDATE secretariat_proposals SET read_at = COALESCE(read_at, NOW())
      WHERE id = $1 AND user_id = $2`, [proposalId, userId]);
    return result.changes === 1;
  },
  async respond(userId: number, id: string, action: 'show' | 'skip' | 'today'): Promise<boolean> {
    return transaction(async client => {
      const db = withClient(client);
      const settings = await db.queryOne(`SELECT enabled FROM secretariat_settings WHERE user_id = $1 FOR UPDATE`, [userId]);
      if (!settings?.enabled) return false;
      const result = await db.execute(`UPDATE secretariat_proposals SET shown_at = COALESCE(shown_at, NOW()),
        read_at = CASE WHEN $3 <> 'show' THEN COALESCE(read_at, NOW()) ELSE read_at END
        WHERE id = $1 AND user_id = $2 AND read_at IS NULL
        AND ($3 <> 'show' OR shown_at IS NULL)`, [id, userId, action]);
      if (!result.changes) return false;
      if (action !== 'show') await db.execute(`UPDATE secretariat_settings SET generation = generation + 1,
        next_run_at = GREATEST(next_run_at, NOW() + CASE WHEN $2 = 'today' THEN INTERVAL '24 hours' ELSE INTERVAL '1 hour' END)
        WHERE user_id = $1`, [userId, action]);
      return true;
    });
  },
  async context(userId: number, candidate: Candidate): Promise<Array<{ role: string; text: string }>> {
    const rows = await query<{ role: string; content: string }>(`SELECT m.role, LEFT(m.content, 16000) AS content
      FROM messages m JOIN sessions s ON s.id = m.session_id
      WHERE s.id = $1 AND ${participatedSessionSql('$2')} AND s.project_id = $3
        AND m.role IN ('user', 'assistant') AND m.parent_tool_use_id IS NULL
        AND COALESCE(m.metadata->>'contextState', 'active') = 'active'
      ORDER BY m.created_at DESC, m.id DESC LIMIT 12`, [candidate.sessionId, userId, candidate.projectId]);
    return rows.reverse().flatMap(row => {
      try {
        const blocks = JSON.parse(row.content);
        const text = typeof blocks === 'string' ? blocks : Array.isArray(blocks)
          ? blocks.filter(b => (b.type === 'text' || (b.type === 'commentary' && b.visibility === 'progress')) && b.visibility !== 'hidden' && typeof b.text === 'string').map(b => b.text).join('\n') : '';
        return text ? [{ role: row.role, text: text.slice(0, 1000) }] : [];
      } catch { return /^[\s]*[\[{]/.test(row.content) ? [] : [{ role: row.role, text: row.content.slice(0, 1000) }]; }
    });
  },
  async secretaryContext(userId: number, candidate: Candidate): Promise<Array<{ role: string; text: string }>> {
    const rows = await query<{ role: string; body: string }>(`SELECT role, LEFT(body, 1000) AS body
      FROM secretariat_chat_messages WHERE user_id=$1 AND project_id=$2 AND session_id=$3
      ORDER BY created_at DESC, CASE role WHEN 'assistant' THEN 1 ELSE 0 END DESC, id DESC LIMIT 8`,
      [userId, candidate.projectId, candidate.sessionId]);
    return rows.reverse().map(row => ({ role: row.role, text: `[Recent private secretary conversation] ${row.body}` }));
  },
  async dueUsers(): Promise<number[]> {
    const rows = await query<{ user_id: number }>(`SELECT ss.user_id FROM secretariat_settings ss
      JOIN users u ON u.id = ss.user_id WHERE ss.enabled = TRUE AND ss.next_run_at <= NOW()
      AND (ss.claim_until IS NULL OR ss.claim_until < NOW()) AND u.disabled = 0
      AND u.approval_status = 'active' AND u.role IN ('admin', 'operator', 'member')
      AND NOT EXISTS (SELECT 1 FROM secretariat_proposals p WHERE p.user_id = ss.user_id AND p.read_at IS NULL)
      ORDER BY ss.next_run_at LIMIT 3`);
    return rows.map(row => row.user_id);
  },
  async defer(userId: number): Promise<void> {
    await execute(`UPDATE secretariat_settings SET next_run_at = NOW() + INTERVAL '1 hour'
      WHERE user_id = $1 AND next_run_at <= NOW() AND (claim_until IS NULL OR claim_until < NOW())`, [userId]);
  },
  async claim(userId: number, manual = false): Promise<Claim | null> {
    if (manual) await execute('INSERT INTO secretariat_settings(user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
    const token = randomUUID();
    // A single SQL statement gives multi-process claim + durable dedup. No network call inside a DB transaction.
    const row = await queryOne<{ generation: number; manual?: boolean }>(`WITH claimed AS (
      UPDATE secretariat_settings ss SET claim_token = $2, claim_until = NOW() + INTERVAL '2 minutes',
        next_run_at = CASE WHEN $3 THEN next_run_at ELSE NOW() + INTERVAL '1 hour' END
      WHERE ss.user_id = $1 AND (ss.enabled = TRUE OR $3) AND (ss.next_run_at <= NOW() OR $3)
        AND NOT EXISTS (SELECT 1 FROM secretariat_runs r WHERE r.user_id = ss.user_id
          AND r.occurrence = CASE WHEN $3 THEN 'manual:' || floor(extract(epoch FROM NOW()) / 60)::text ELSE floor(extract(epoch FROM NOW()) / 3600)::text END)
        AND (ss.claim_until IS NULL OR ss.claim_until < NOW())
        AND (NOT $3 OR NOT EXISTS (SELECT 1 FROM secretariat_runs r WHERE r.user_id=ss.user_id AND r.created_at > NOW() - INTERVAL '1 minute'))
        AND EXISTS (SELECT 1 FROM users u WHERE u.id = ss.user_id AND u.disabled = 0
          AND u.approval_status = 'active' AND u.role IN ('admin', 'operator', 'member'))
        AND NOT EXISTS (SELECT 1 FROM secretariat_proposals p WHERE p.user_id = ss.user_id AND p.read_at IS NULL)
      RETURNING generation
    ), recorded AS (
      INSERT INTO secretariat_runs (id, user_id, occurrence, status)
      SELECT $2, $1, CASE WHEN $3 THEN 'manual:' || floor(extract(epoch FROM NOW()) / 60)::text ELSE floor(extract(epoch FROM NOW()) / 3600)::text END, 'claimed' FROM claimed
      ON CONFLICT (user_id, occurrence) DO NOTHING RETURNING id
    ) SELECT generation FROM claimed WHERE EXISTS (SELECT 1 FROM recorded)`, [userId, token, manual]);
    return row ? { userId, token, generation: row.generation, ...(manual ? { manual: true } : {}) } : null;
  },
  async stillAllowed(claim: Claim): Promise<boolean> {
    return !!await queryOne(`SELECT 1 FROM secretariat_settings ss JOIN users u ON u.id = ss.user_id
      WHERE ss.user_id = $1 AND (ss.enabled = TRUE OR $4) AND ss.generation = $3
        AND ss.claim_token = $2 AND ss.claim_until > NOW() AND u.disabled = 0
        AND u.approval_status = 'active' AND u.role IN ('admin', 'operator', 'member')
        AND NOT EXISTS (SELECT 1 FROM secretariat_proposals p WHERE p.user_id = ss.user_id AND p.read_at IS NULL)`,
    [claim.userId, claim.token, claim.generation, !!claim.manual]);
  },
  async candidates(userId: number, includePreviouslyProposed = false): Promise<Candidate[]> {
    const rows = await query<any>(includePreviouslyProposed ? sessionCandidatesSql.replace(/    AND NOT EXISTS \(SELECT 1 FROM secretariat_proposals[^\n]*\n/, '') : sessionCandidatesSql, [userId]);
    return rows.map(row => ({ id: row.id, sourceKey: row.source_key,
      title: String(row.run_title || '').slice(0, 180), outcome: String(row.outcome || '').slice(0, 600),
      updatedAt: iso(row.updated_at), sessionId: row.session_id, projectId: row.project_id }));
  },
  async sourceCurrent(userId: number, candidate: Candidate): Promise<boolean> {
    return (await this.candidates(userId)).some(c => c.id === candidate.id && c.sourceKey === candidate.sourceKey);
  },
  async insert(claim: Claim, candidate: Candidate, text: { title: string; body: string; delivery?: 'popup' | 'inbox' }): Promise<boolean> {
    return transaction(async client => {
      const db = withClient(client);
      // Serialize delivery against on/off changes. If OFF commits first, no stale proposal is inserted.
      const lock = await db.queryOne(`SELECT 1 FROM secretariat_settings
        WHERE user_id = $1 FOR UPDATE`, [claim.userId]);
      if (!lock) return false;
      const result = await db.execute(`INSERT INTO secretariat_proposals
      (id, user_id, source_key, title, body, session_id, project_id, delivery)
      SELECT $4, $1, $5, $6, $7, $8, $9, $10 FROM secretariat_settings ss
      WHERE ss.user_id = $1 AND (ss.enabled = TRUE OR $11) AND ss.generation = $3
        AND ss.claim_token = $2 AND ss.claim_until > NOW()
        AND EXISTS (SELECT 1 FROM users u WHERE u.id = $1 AND u.disabled = 0 AND u.approval_status = 'active'
          AND (u.role = 'admin' OR (u.role IN ('member', 'operator') AND EXISTS
            (SELECT 1 FROM project_members pm WHERE pm.project_id = $9 AND pm.user_id = $1))))
        AND NOT EXISTS (SELECT 1 FROM secretariat_proposals p WHERE p.user_id = $1 AND p.read_at IS NULL)
        AND EXISTS (SELECT 1 FROM sessions s JOIN projects p ON p.id = s.project_id
          WHERE s.id = $8 AND s.project_id = $9 AND ${participatedSessionSql('$1')}
          AND COALESCE(s.archived,0)=0 AND COALESCE(p.archived,0)=0
          AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id=s.project_id AND pm.user_id=$1)
          AND s.id || ':' || (SELECT MAX(m.created_at)::text FROM messages m WHERE m.session_id=s.id
            AND m.role IN ('user','assistant') AND m.parent_tool_use_id IS NULL
            AND COALESCE(m.metadata->>'contextState','active')='active') = $5)
      ON CONFLICT DO NOTHING`, [claim.userId, claim.token, claim.generation, randomUUID(), candidate.sourceKey,
      text.title, text.body, candidate.sessionId, candidate.projectId, text.delivery || 'popup', !!claim.manual]);
      return result.changes === 1;
    });
  },
  async finish(claim: Claim, status: RunStatus, diagnostic: Record<string, string | number> = {}): Promise<void> {
    await execute('UPDATE secretariat_runs SET status = $2, finished_at = NOW(), diagnostic = $4::jsonb WHERE id = $1 AND user_id = $3',
      [claim.token, status, claim.userId, JSON.stringify(diagnostic)]);
    await execute('UPDATE secretariat_settings SET claim_token = NULL, claim_until = NULL WHERE user_id = $1 AND claim_token = $2',
      [claim.userId, claim.token]);
  },
};
export type SecretariatStore = typeof secretariatStore;
