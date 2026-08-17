/**
 * Owns: browser-facing parsing and content URLs for session-scoped attachments.
 * Public API: identify a session:// attachment URI and map it to the authenticated HTTP endpoint.
 */

const SESSION_ATTACHMENT_URI_RE = /^session:\/\/attachments\/([0-9a-f-]{36})$/i;

/** Return the attachment UUID when the value is a canonical session attachment URI. */
export function sessionAttachmentIdFromUri(uri: string): string | null {
  return SESSION_ATTACHMENT_URI_RE.exec(String(uri || '').trim())?.[1] || null;
}

/** Build the same-session content endpoint used by chat thumbnails and Viewer tabs. */
export function sessionAttachmentContentUrl(sessionId: string, uri: string, token?: string | null): string | null {
  const attachmentId = sessionAttachmentIdFromUri(uri);
  if (!sessionId || !attachmentId) return null;
  const base = `/api/session-attachments/${encodeURIComponent(sessionId)}/${encodeURIComponent(attachmentId)}/content`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}
