import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore, type Attachment } from './chat-store';

const file: Attachment = { id: 'file-a', type: 'file', label: 'a.csv', content: 'session://attachments/file-a' };
beforeEach(() => useChatStore.setState({ sessionId: null, attachments: [], attachmentDrafts: {}, attachmentUploadProgress: {} }));

describe('session attachment drafts', () => {
  it('restores independent drafts and preserves removals and send clearing', () => {
    const chat = useChatStore.getState();
    chat.setSessionId('a');
    chat.addAttachment(file);
    chat.setSessionId('b');
    expect(useChatStore.getState().attachments).toEqual([]);
    chat.addAttachment({ ...file, id: 'file-b' });
    chat.setSessionId('a');
    expect(useChatStore.getState().attachments).toEqual([file]);
    chat.removeAttachment(file.id);
    chat.setSessionId('b');
    expect(useChatStore.getState().attachments[0].id).toBe('file-b');
    chat.clearAttachments();
    chat.setSessionId('a');
    expect(useChatStore.getState().attachments).toEqual([]);
    chat.setSessionId('b');
    expect(useChatStore.getState().attachments).toEqual([]);
  });

  it('routes late upload completion to the originating session only and deduplicates', () => {
    const chat = useChatStore.getState();
    chat.setSessionId('a');
    chat.setSessionId('b');
    chat.addAttachment(file, 'a');
    chat.addAttachment(file, 'a');
    expect(useChatStore.getState().attachments).toEqual([]);
    chat.setSessionId('a');
    expect(useChatStore.getState().attachments).toEqual([file]);
    chat.addAttachment(file, 'a');
    expect(useChatStore.getState().attachments).toEqual([file]);
  });
});
