import { describe, expect, it } from 'vitest';
import {
  PROVIDER_CAPACITY_EXHAUSTED_NOTICE_TEXT,
  TRANSIENT_ABORT_EXHAUSTED_NOTICE_TEXT,
  appendTransientNoticeIfMissing,
  makeTransientNoticeBlock,
} from '../pi/transient-notice.js';
import type { TowerContentBlock } from '../types.js';

describe('Pi transient notice helpers', () => {
  it('creates stable Korean terminal failure notice blocks', () => {
    expect(makeTransientNoticeBlock(PROVIDER_CAPACITY_EXHAUSTED_NOTICE_TEXT)).toEqual({
      type: 'text',
      text: PROVIDER_CAPACITY_EXHAUSTED_NOTICE_TEXT,
    });
    expect(makeTransientNoticeBlock(TRANSIENT_ABORT_EXHAUSTED_NOTICE_TEXT)).toEqual({
      type: 'text',
      text: TRANSIENT_ABORT_EXHAUSTED_NOTICE_TEXT,
    });
  });

  it('appends a terminal notice without mutating existing content', () => {
    const current: TowerContentBlock[] = [{ type: 'text', text: 'partial answer' }];
    const terminalNotice = makeTransientNoticeBlock(TRANSIENT_ABORT_EXHAUSTED_NOTICE_TEXT);
    const result = appendTransientNoticeIfMissing(current, terminalNotice);

    expect(result.appended).toBe(true);
    expect(result.content).toEqual([
      { type: 'text', text: 'partial answer' },
      { type: 'text', text: TRANSIENT_ABORT_EXHAUSTED_NOTICE_TEXT },
    ]);
    expect(current).toEqual([{ type: 'text', text: 'partial answer' }]);
  });

  it('does not append a duplicate terminal notice', () => {
    const current: TowerContentBlock[] = [
      { type: 'text', text: 'partial answer' },
      { type: 'text', text: TRANSIENT_ABORT_EXHAUSTED_NOTICE_TEXT },
    ];
    const result = appendTransientNoticeIfMissing(
      current,
      makeTransientNoticeBlock(TRANSIENT_ABORT_EXHAUSTED_NOTICE_TEXT),
    );

    expect(result.appended).toBe(false);
    expect(result.content).toBe(current);
  });

  it('deduplicates against the requested failure notice text', () => {
    const current: TowerContentBlock[] = [
      { type: 'text', text: 'partial answer' },
      { type: 'text', text: PROVIDER_CAPACITY_EXHAUSTED_NOTICE_TEXT },
    ];
    const result = appendTransientNoticeIfMissing(current, makeTransientNoticeBlock(PROVIDER_CAPACITY_EXHAUSTED_NOTICE_TEXT));

    expect(result.appended).toBe(false);
    expect(result.content).toBe(current);
  });
});
