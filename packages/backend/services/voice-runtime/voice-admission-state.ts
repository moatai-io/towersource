/** Read-only classification: stale/recovery state is not a retryable live voice BUSY. */
import { queryOne } from '../../db/pg-repo.js';
export type VoiceAdmissionFailure = 'VOICE_BUSY' | 'VOICE_RECOVERY_REQUIRED';
export interface VoiceOwnerSnapshot {
  state: string;
  has_owner: boolean;
  lease_until: string | null;
  waiting_user: boolean;
  last_failure_class: string | null;
}
export function classifyVoiceOwner(snapshot: VoiceOwnerSnapshot | undefined, now = Date.now()): VoiceAdmissionFailure {
  // Recovery/approval needs a distinct user-visible outcome, not endless 500ms retries.
  if (snapshot?.state === 'waiting_retry' || snapshot?.waiting_user) return 'VOICE_RECOVERY_REQUIRED';
  if (snapshot?.state === 'running' || snapshot?.state === 'stop_requested') {
    if (snapshot.last_failure_class === 'abandoned_owner') return 'VOICE_RECOVERY_REQUIRED';
    if (snapshot.has_owner && snapshot.lease_until && Date.parse(snapshot.lease_until) <= now) return 'VOICE_RECOVERY_REQUIRED';
  }
  // Missing/transitioning rows fail closed; never infer idle or mutate the original root.
  return 'VOICE_BUSY';
}
export async function voiceAdmissionFailure(sessionId: string, rootTurnId: string): Promise<VoiceAdmissionFailure> {
  const snapshot = await queryOne<VoiceOwnerSnapshot>(`SELECT state, (owner_token IS NOT NULL) AS has_owner,
    lease_until::text, (waiting_user_started_at IS NOT NULL) AS waiting_user, last_failure_class
    FROM agent_turns WHERE session_id = $1 AND root_turn_id = $2`, [sessionId, rootTurnId]);
  return classifyVoiceOwner(snapshot);
}
