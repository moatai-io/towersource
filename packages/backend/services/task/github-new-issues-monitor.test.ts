import { describe, expect, it } from 'vitest';
import {
  buildIssueResearchPrompt,
  normalizeGitHubIssueFetchLimit,
  selectNewGitHubIssues,
  type GitHubIssueSummary,
} from './automation-runners.js';

function issue(number: number, createdAt = `2026-06-${String(number).padStart(2, '0')}T00:00:00Z`): GitHubIssueSummary {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/juliuschun/tower/issues/${number}`,
    createdAt,
    author: 'tester',
    body: '',
  };
}

describe('github_new_issues monitor selection', () => {
  it('filters out baseline and already processed issues while preserving ascending issue order', () => {
    const selection = selectNewGitHubIssues(
      [issue(117), issue(115), issue(119), issue(118)],
      116,
      new Set([118]),
    );

    expect(selection.newIssues.map((item) => item.number)).toEqual([117, 119]);
    expect(selection.skippedByBaseline).toEqual([115]);
    expect(selection.skippedByProcessed).toEqual([118]);
    expect(selection.highestFetchedIssueNumber).toBe(119);
  });

  it('returns no new issues when all fetched issues are baseline or processed', () => {
    const selection = selectNewGitHubIssues(
      [issue(100), issue(101), issue(102)],
      101,
      new Set([102]),
    );

    expect(selection.newIssues).toEqual([]);
    expect(selection.skippedByBaseline).toEqual([100, 101]);
    expect(selection.skippedByProcessed).toEqual([102]);
  });

  it('keeps createdAt cursor metadata for visibility without changing number-based detection', () => {
    const selection = selectNewGitHubIssues(
      [
        issue(12, '2026-06-23T04:20:00Z'),
        issue(10, '2026-06-23T04:10:00Z'),
        issue(11, '2026-06-23T04:15:00Z'),
      ],
      9,
      new Set(),
    );

    expect(selection.oldestFetchedIssueNumber).toBe(10);
    expect(selection.newestFetchedIssueNumber).toBe(12);
    expect(selection.oldestFetchedCreatedAt).toBe('2026-06-23T04:10:00Z');
    expect(selection.newestFetchedCreatedAt).toBe('2026-06-23T04:20:00Z');
  });

  it('defaults fetch limit to the GitHub CLI maximum and clamps explicit values', () => {
    expect(normalizeGitHubIssueFetchLimit(undefined)).toBe(100);
    expect(normalizeGitHubIssueFetchLimit(0)).toBe(1);
    expect(normalizeGitHubIssueFetchLimit(30.8)).toBe(30);
    expect(normalizeGitHubIssueFetchLimit(500)).toBe(100);
  });

  it('asks issue research tasks to prepare selectable plans and impact before editing', () => {
    const prompt = buildIssueResearchPrompt('juliuschun/tower', issue(120));

    expect(prompt).toContain('오케이');
    expect(prompt).toContain('즉시 수정 가능한 지점');
    expect(prompt).toContain('수정 계획서');
    expect(prompt).toContain('우리에게 미칠 임팩트');
    expect(prompt).toContain('선택하면 할 일');
    expect(prompt).toContain('승인 대기 상태로 끝내라');
    expect(prompt).toContain('코드 수정, 커밋, 배포는 하지 말고');
  });
});
