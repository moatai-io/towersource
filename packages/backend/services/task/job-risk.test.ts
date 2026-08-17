import { describe, expect, it } from 'vitest';
import { classifyJobRisk } from './job-risk.js';

describe('classifyJobRisk', () => {
  it('classifies GET webhooks as low risk', () => {
    expect(classifyJobRisk('webhook', { url: 'https://example.com', method: 'GET' })).toBe('low');
  });

  it('classifies POST webhooks as medium risk', () => {
    expect(classifyJobRisk('webhook', { url: 'https://example.com', method: 'POST' })).toBe('medium');
  });

  it('classifies AI prompt jobs as low risk', () => {
    expect(classifyJobRisk('ai_prompt', { prompt: 'summarize' })).toBe('low');
  });
});
