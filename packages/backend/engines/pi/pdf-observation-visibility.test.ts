import { describe, expect, it } from 'vitest';
import { stripPdfObservationText } from './pdf-observation-visibility.js';
import { ContentAccumulator, agentMessageToTowerBlocks } from './message-adapter.js';
import { handlePiMessageUpdate } from './message-update-handler.js';
import { analyzePiMessageEndCore } from './message-end-handler.js';
const marker = '[PDF observation batch=123456789012345678901234]';
const note = `${marker} Pages 1-2 findings: confidential table detail. [/PDF observation]`;

describe('PDF observation notes stay private in visible message paths', () => {
  it('removes delimited notes but preserves final prose and ordinary text', () => {
    expect(stripPdfObservationText(`${note}\nFinal answer.`).trim()).toBe('Final answer.');
    expect(stripPdfObservationText(`Intro. ${note} Conclusion.`)).toBe('Intro.  Conclusion.');
    expect(stripPdfObservationText('Ordinary [link](url) text')).toBe('Ordinary [link](url) text');
  });
  it('holds markers split at every streaming boundary and never reveals note contents', () => {
    for (let n = 1; n <= note.length; n++) {
      expect(stripPdfObservationText(note.slice(0, n))).toBe('');
    }
    expect(stripPdfObservationText(`${marker} legacy unclosed note`)).toBe('');
  });
  it('filters text and commentary while retaining tool cards and canonical content', () => {
    const msg = { role: 'assistant', content: [{ type: 'text', text: note }, { type: 'toolCall', id: 't', name: 'pdf_view', arguments: {} }] };
    const before = JSON.stringify(msg);
    expect(agentMessageToTowerBlocks(msg)).toEqual([{ type: 'tool_use', id: 't', name: 'pdf_view', input: {} }]);
    expect(JSON.stringify(msg)).toBe(before);
    expect(agentMessageToTowerBlocks({ content: [{ type: 'text', text: note, textSignature: JSON.stringify({ phase: 'commentary' }) }] })).toEqual([]);
  });
  it('filters stream deltas and message_end persistence using the same adapter', () => {
    const accumulator = new ContentAccumulator();
    for (const delta of [marker.slice(0, 5), marker.slice(5), ' hidden findings ', '[/PDF observation]', ' Final answer.']) {
      const update = handlePiMessageUpdate({ event: { assistantMessageEvent: { type: 'text_delta', delta } }, accumulator });
      expect(JSON.stringify(update.content)).not.toContain('hidden findings');
      expect(JSON.stringify(update.content)).not.toContain('PDF observation');
    }
    const result = analyzePiMessageEndCore({ msg: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: `${note} Final answer.` }] },
      accumulatorContent: accumulator.toTowerBlocks() });
    expect(result.assistantContent?.contentToSave).toEqual([{ type: 'text', text: ' Final answer.' }]);
  });
});
