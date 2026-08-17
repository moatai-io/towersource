import { describe, expect, it, beforeEach } from 'vitest';
import { useRoomStore, type RoomMessage } from './room-store';

function baseMessage(id: string, content = ''): RoomMessage {
  return {
    id,
    roomId: 'room-1',
    senderId: null,
    senderName: null,
    seq: 0,
    msgType: 'ai_reply',
    content,
    metadata: {},
    taskId: null,
    replyTo: null,
    editedAt: null,
    deletedAt: null,
    createdAt: new Date(0).toISOString(),
  };
}

describe('room-store', () => {
  beforeEach(() => {
    useRoomStore.setState({
      rooms: [],
      activeRoomId: null,
      messagesByRoom: {},
      membersByRoom: {},
      unreadCounts: {},
      typingByRoom: {},
      notifications: [],
      unreadNotifCount: 0,
      loading: false,
      messagesLoading: false,
      pgEnabled: false,
      collapsedRoomGroups: new Set(),
    });
  });

  it('updates a room message by its final id after a streaming placeholder id was replaced', () => {
    useRoomStore.getState().setMessages('room-1', [baseMessage('ai-reply-placeholder')]);

    useRoomStore.getState().updateMessage('room-1', 'ai-reply-placeholder', {
      id: 'db-final-message',
      content: 'final content',
      metadata: { streaming: false, streamPlaceholderId: 'ai-reply-placeholder' },
    });

    useRoomStore.getState().updateMessage('room-1', 'db-final-message', {
      content: 'edited after final id',
    });

    expect(useRoomStore.getState().messagesByRoom['room-1']).toEqual([
      expect.objectContaining({
        id: 'db-final-message',
        content: 'edited after final id',
        metadata: { streaming: false, streamPlaceholderId: 'ai-reply-placeholder' },
      }),
    ]);
  });
});
