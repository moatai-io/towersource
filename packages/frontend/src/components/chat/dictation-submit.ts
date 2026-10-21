const handlers = new Map<string, () => Promise<boolean> | boolean>();
export function registerDictationFinalizer(sessionId: string, handler: () => Promise<boolean> | boolean) {
  handlers.set(sessionId, handler);
  return () => { if (handlers.get(sessionId) === handler) handlers.delete(sessionId); };
}
export function finalizeDictationForSend(sessionId: string | null): Promise<boolean> | boolean {
  return sessionId ? handlers.get(sessionId)?.() ?? true : true;
}
