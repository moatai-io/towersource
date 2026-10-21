import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8');

describe('major surfaces translated chrome', () => {
  it('localizes Git actions, relative dates, and destructive rollback warning', () => {
    const source = read('git/GitPanel.tsx');
    for (const key of ['viewDiff', 'rollback', 'minutesAgo', 'hoursAgo', 'daysAgo', 'filesChanged', 'noSnapshots', 'confirmRollbackTitle', 'rollbackRecord']) {
      expect(source).toContain(`t('${key}'`);
    }
    expect(source).toContain('toLocaleDateString(language)');
    expect(source).not.toContain("toLocaleDateString('en-US')");
    expect(source).not.toContain('>Confirm Rollback<');
    expect(source).not.toContain('>No snapshots yet<');
    expect(source).toContain('미저장 변경 내용은 잃을 수 있습니다.');
    expect(source).not.toContain('롤백 전 스냅샷으로 보존됩니다.');
  });

  it('localizes editor, viewer, usage, helper-agent, and diagram controls', () => {
    const cases = [
      ['files/markdown-editor/MarkdownEditor.tsx', "t('markdownEditor.link'", '>Link</button>'],
      ['layout/ViewerPane.tsx', "t('viewer')", '>Viewer</span>'],
      ['layout/ContextPanel.tsx', "t('modified'", '>Modified</span>'],
      ['usage/UsagePanel.tsx', "tr('usage.title'", '>Usage</h1>'],
      ['agents/AgentsPanel.tsx', "t('agentsPanel.latestRun'", '>Latest run</div>'],
      ['chat/MermaidBlock.tsx', "t('diagram.controls'", 'title="Download SVG"'],
      ['sessions/SummaryCard.tsx', "t('sessionSummary.title'", "? 'Summary' : 'No summary'"],
      ['chat/InputBox.tsx', "t('dropHere'", '>Drop here</span>'],
      ['work/ChallengeTimelinePanel.tsx', "tr('challenge.timeline.sessionBreakdown'", '>Session breakdown</h3>'],
    ];
    for (const [file, translated, hardcoded] of cases) {
      const source = read(file);
      expect(source, file).toContain(translated);
      expect(source, file).not.toContain(hardcoded);
    }
  });
});
