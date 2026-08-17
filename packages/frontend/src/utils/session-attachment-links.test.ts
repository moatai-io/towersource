import { describe, expect, it } from 'vitest';
import { sessionAttachmentContentUrl } from './session-attachment-links';

const uri = 'session://attachments/11111111-1111-4111-8111-111111111111';

describe('sessionAttachmentContentUrl', () => {
  it('adds the browser auth token for direct image and document requests', () => {
    expect(sessionAttachmentContentUrl('session-1', uri, 'token with spaces')).toBe(
      '/api/session-attachments/session-1/11111111-1111-4111-8111-111111111111/content?token=token%20with%20spaces',
    );
  });

  it('keeps the endpoint usable when auth is disabled', () => {
    expect(sessionAttachmentContentUrl('session-1', uri)).toBe(
      '/api/session-attachments/session-1/11111111-1111-4111-8111-111111111111/content',
    );
  });
});
