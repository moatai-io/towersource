import { describe, expect, it } from 'vitest';
import { extractTextFromContent } from './text.js';

describe('extractTextFromContent', () => {
  it('includes artifact-backed markdown text in plain text extraction', () => {
    const content = JSON.stringify([
      { type: 'text', text: 'Intro' },
      { type: 'artifact_markdown', path: 'work/report.md', text: '# Report\n\nBody' },
      { type: 'agent_run', workerName: 'Worker', summary: 'done' },
    ]);

    expect(extractTextFromContent(content)).toBe('Intro # Report\n\nBody Worker done');
  });
});
