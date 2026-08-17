/**
 * Pure functions for session isolation logic.
 * sessionClients is 1:many — a session can have multiple viewing clients (tabs).
 */

export interface SessionClient {
  id: string;
  sessionId?: string;
  activeQueryEpoch: number;
}

/**
 * Check if the client's epoch has advanced past myEpoch,
 * meaning the query loop is stale and should stop.
 */
export function isEpochStale(client: SessionClient, myEpoch: number): boolean {
  return client.activeQueryEpoch !== myEpoch;
}

/** Add a client to a session's viewer set. */
export function addSessionClient(
  sessionClients: Map<string, Set<string>>,
  sessionId: string,
  clientId: string,
): void {
  let set = sessionClients.get(sessionId);
  if (!set) {
    set = new Set();
    sessionClients.set(sessionId, set);
  }
  set.add(clientId);
}

/** Remove a client from a session's viewer set. Cleans up empty sets. */
export function removeSessionClient(
  sessionClients: Map<string, Set<string>>,
  sessionId: string,
  clientId: string,
): void {
  const set = sessionClients.get(sessionId);
  if (set) {
    set.delete(clientId);
    if (set.size === 0) sessionClients.delete(sessionId);
  }
}

/**
 * Find any live client viewing a given session.
 * Used as fallback when the originating client disconnects (reconnection).
 */
export function findSessionClient<T extends SessionClient>(
  sessionClients: Map<string, Set<string>>,
  clients: Map<string, T>,
  sessionId: string,
): T | undefined {
  const clientIds = sessionClients.get(sessionId);
  if (!clientIds) return undefined;

  for (const clientId of clientIds) {
    const client = clients.get(clientId);
    if (client && client.sessionId === sessionId) {
      return client;
    }
  }

  return undefined;
}

/**
 * Handle session switch: remove from old set, add to new set, bump epoch.
 * Returns the new epoch value.
 */
export function switchSession(
  client: SessionClient,
  sessionClients: Map<string, Set<string>>,
  oldSessionId: string | undefined,
  newSessionId: string,
): number {
  // Remove from old session's viewer set
  if (oldSessionId && oldSessionId !== newSessionId) {
    removeSessionClient(sessionClients, oldSessionId, client.id);
  }

  // Invalidate any running query loop
  client.activeQueryEpoch++;

  // Update client to new session and add to viewer set
  client.sessionId = newSessionId;
  addSessionClient(sessionClients, newSessionId, client.id);

  return client.activeQueryEpoch;
}

/**
 * Handle abort cleanup: bump epoch and remove from session viewer set.
 * Returns the new epoch value.
 */
export function abortCleanup(
  client: SessionClient,
  sessionClients: Map<string, Set<string>>,
  sessionId: string,
): number {
  client.activeQueryEpoch++;
  removeSessionClient(sessionClients, sessionId, client.id);
  return client.activeQueryEpoch;
}
