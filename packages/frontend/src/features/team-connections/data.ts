export interface TeamPerson { id: number; username: string }
export interface TeamMember { userId: number; username: string; role: string }
export interface TeamConnections { people: TeamPerson[]; members: Record<string, TeamMember[]>; unavailable: string[] }

/** Reuse the member-list ACL; never infer connections from private conversations or global roles. */
export async function loadTeamConnections(ids: string[], signal: AbortSignal): Promise<TeamConnections> {
  const token = localStorage.getItem('token');
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const result: TeamConnections = { people: [], members: {}, unavailable: [] };
  const users = await fetch('/api/users/search?q=', { headers, signal });
  if (!users.ok) throw new Error('people unavailable');
  const payload = await users.json();
  if (!Array.isArray(payload)) throw new Error('invalid people');
  result.people = payload.filter((p): p is TeamPerson => Number.isInteger(p?.id) && typeof p?.username === 'string');
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
    while (next < ids.length) {
      signal.throwIfAborted();
      const id = ids[next++];
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(id)}/members`, { headers, signal });
        if (!response.ok) throw new Error('members unavailable');
        const rows = await response.json();
        if (!Array.isArray(rows)) throw new Error('invalid members');
        result.members[id] = rows.filter((m): m is TeamMember => Number.isInteger(m?.userId) && typeof m?.username === 'string' && typeof m?.role === 'string');
      } catch (error) {
        if (signal.aborted) throw error;
        result.unavailable.push(id);
      }
    }
  }));
  const people = new Map(result.people.map(p => [p.id, p]));
  Object.values(result.members).flat().forEach(m => people.set(m.userId, { id: m.userId, username: m.username }));
  result.people = [...people.values()];
  return result;
}
