import { describe, expect, it } from 'vitest';
import { beginAttachmentUpload, hasAttachmentUploads, waitForAttachmentUploads } from './attachment-upload-barrier';

describe('attachment upload barrier', () => {
  it('waits for all batches including another selection made while waiting', async () => {
    const finishA = beginAttachmentUpload('barrier-a');
    const wait = waitForAttachmentUploads('barrier-a');
    const finishB = beginAttachmentUpload('barrier-a');
    finishA(true);
    await Promise.resolve();
    expect(hasAttachmentUploads('barrier-a')).toBe(true);
    finishB(true);
    expect(await wait).toBe(true);
    expect(hasAttachmentUploads('barrier-a')).toBe(false);
  });

  it('isolates sessions and reports partial failures', async () => {
    const finish = beginAttachmentUpload('barrier-failed');
    expect(await waitForAttachmentUploads('barrier-other')).toBe(true);
    const wait = waitForAttachmentUploads('barrier-failed');
    finish(false);
    expect(await wait).toBe(false);
  });
});
