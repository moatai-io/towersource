import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRunUtilityTextTask = vi.fn();

describe('summarizer', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doMock('./utility-agent.js', () => ({
      runUtilityTextTask: mockRunUtilityTextTask,
    }));
  });

  it('uses utility-agent and returns trimmed summary', async () => {
    mockRunUtilityTextTask.mockResolvedValueOnce('  Summary text  ');
    const { generateSummary } = await import('./summarizer.ts');

    const result = await generateSummary('message log');
    expect(mockRunUtilityTextTask).toHaveBeenCalledTimes(1);
    expect(result).toBe('Summary text');
  });

  it('falls back to failure message when utility-agent returns empty text', async () => {
    mockRunUtilityTextTask.mockResolvedValueOnce('');
    const { generateSummary } = await import('./summarizer.ts');

    const result = await generateSummary('message log');
    expect(result).toBe('Summary generation failed');
  });
});
