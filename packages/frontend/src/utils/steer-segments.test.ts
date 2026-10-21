import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../stores/chat-store';
import { mergeConsecutiveAssistant } from '../features/agent-card/agent-message-policy';
import { segmentMessagesAroundDeliveredSteers } from './steer-segments';

const assistant: ChatMessage = {
  id: 'a1', role: 'assistant', timestamp: 1,
  content: [{ type: 'text', text: 'before middle after' }],
};

describe('segmentMessagesAroundDeliveredSteers', () => {
  it('places a delivered steer between cumulative assistant snapshots', () => {
    const steer: ChatMessage = {
      id: 's1', role: 'user', timestamp: 2, content: [{ type: 'text', text: 'change it' }],
      metadata: { steerDelivery: { assistantMsgId: 'a1', assistantContent: [{ type: 'text', text: 'before ' }] } },
    };
    const out = segmentMessagesAroundDeliveredSteers([assistant, steer]);
    expect(out.map((m) => [m.role, m.content[0]?.text])).toEqual([
      ['assistant', 'before '],
      ['user', 'change it'],
      ['assistant', 'middle after'],
    ]);
  });

  it('supports multiple steer boundaries in one assistant response', () => {
    const group: ChatMessage = {
      id: 's1', role: 'user', timestamp: 2, content: [{ type: 'text', text: 'first\n\nsecond' }],
      metadata: { kind: 'pi-steer-group', steerIds: ['s1', 's2'], steerItems: [
        { id: 's1', text: 'first', assistantMsgId: 'a1', assistantContent: [{ type: 'text', text: 'before ' }] },
        { id: 's2', text: 'second', assistantMsgId: 'a1', assistantContent: [{ type: 'text', text: 'before middle ' }] },
      ] },
    };
    const out = segmentMessagesAroundDeliveredSteers([assistant, group]);
    expect(out.map((m) => [m.role, m.content[0]?.text])).toEqual([
      ['assistant', 'before '], ['user', 'first'], ['assistant', 'middle '], ['user', 'second'], ['assistant', 'after'],
    ]);
  });

  it('preserves a steer checkpoint on a later assistant iteration before merging', () => {
    const first: ChatMessage = {
      id: 'a0', role: 'assistant', timestamp: 1,
      content: [{ type: 'text', text: 'first iteration' }],
    };
    const second: ChatMessage = {
      id: 'a1', role: 'assistant', timestamp: 2,
      content: [{ type: 'text', text: 'before after' }],
    };
    const steer: ChatMessage = {
      id: 's1', role: 'user', timestamp: 3, content: [{ type: 'text', text: 'redirect' }],
      metadata: { steerDelivery: { assistantMsgId: 'a1', assistantContent: [{ type: 'text', text: 'before ' }] } },
    };

    const out = mergeConsecutiveAssistant(segmentMessagesAroundDeliveredSteers([first, second, steer]));

    expect(out.map((message) => [message.role, message.content.map((block) => block.text).join('')])).toEqual([
      ['assistant', 'first iterationbefore '],
      ['user', 'redirect'],
      ['assistant', 'after'],
    ]);
  });

  it('keeps a tool block whole at a steer boundary', () => {
    const toolAssistant: ChatMessage = {
      id: 'a2', role: 'assistant', timestamp: 1,
      content: [{ type: 'tool_use', toolUse: { id: 't1', name: 'read', input: {} } }, { type: 'text', text: 'done' }],
    };
    const steer: ChatMessage = {
      id: 's1', role: 'user', timestamp: 2, content: [{ type: 'text', text: 'continue' }],
      metadata: { steerDelivery: { assistantMsgId: 'a2', assistantContent: [{ type: 'tool_use', toolUse: { id: 't1', name: 'read', input: {} } }] } },
    };
    const out = segmentMessagesAroundDeliveredSteers([toolAssistant, steer]);
    expect(out[0].content[0].toolUse?.id).toBe('t1');
    expect(out[2].content).toEqual([{ type: 'text', text: 'done' }]);
  });
});
