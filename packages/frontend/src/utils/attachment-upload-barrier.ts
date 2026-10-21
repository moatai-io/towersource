// File selection registers before optimization (not only before the HTTP request).
// Keep barriers outside the composer so a remount cannot lose a running upload.
const pending = new Map<string, Set<Promise<boolean>>>();

export function beginAttachmentUpload(sessionId: string): (success: boolean) => void {
  let resolve!: (success: boolean) => void;
  const promise = new Promise<boolean>((done) => { resolve = done; });
  const uploads = pending.get(sessionId) || new Set<Promise<boolean>>();
  uploads.add(promise);
  pending.set(sessionId, uploads);
  return (success) => {
    uploads.delete(promise);
    if (!uploads.size) pending.delete(sessionId);
    resolve(success);
  };
}

export function hasAttachmentUploads(sessionId: string): boolean {
  return !!pending.get(sessionId)?.size;
}

export async function waitForAttachmentUploads(sessionId: string): Promise<boolean> {
  let success = true;
  while (pending.get(sessionId)?.size) {
    const results = await Promise.all([...pending.get(sessionId)!]);
    success = results.every(Boolean) && success;
  }
  return success;
}
