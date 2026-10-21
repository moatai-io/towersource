import type { SessionMeta } from '@tower/shared';
import { isPureAgentSession } from './classification';

/** Persisted identity, independent of activity or direct human participation. */
export function AgentSessionBadge({ session }: { session: SessionMeta }) {
  if (!isPureAgentSession(session)) return null;
  return (
    <span className="tone-pill tone-warning mr-1 text-[10px] font-bold px-1 rounded align-middle">
      agent
    </span>
  );
}
