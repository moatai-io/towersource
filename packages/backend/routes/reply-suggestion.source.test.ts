import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const API_PATH = path.resolve(process.cwd(), 'packages/backend/routes/api.ts');

describe('reply suggestion source contracts', () => {
  it('keeps draft completion in the human user voice', () => {
    const src = fs.readFileSync(API_PATH, 'utf8');
    const route = src.match(/router\.post\('\/ai\/reply-suggestion'[\s\S]*?\/\/ Auto-name session/);

    expect(route?.[0]).toBeTruthy();
    expect(route?.[0]).toContain('writing assistant embedded inside the HUMAN USER composer');
    expect(route?.[0]).toContain("infer the user\\'s intended speech act");
    expect(route?.[0]).toContain('as if the user had continued typing it themselves');
    expect(route?.[0]).toContain('The draft is not a question addressed to you for an answer');
    expect(route?.[0]).toContain('Draft + suffix must read as one continuous message written entirely by the human user');
    expect(route?.[0]).toContain('<CONVERSATION_HISTORY>');
    expect(route?.[0]).toContain('<CURRENT_USER_DRAFT>');
    expect(route?.[0]).toContain('<CURSOR/>');
  });

  it('preserves leading whitespace in an inline suffix', () => {
    const src = fs.readFileSync(API_PATH, 'utf8');
    expect(src).toContain(".replace(/^[\\r\\n]+|[\\r\\n]+$/g, '')");
    expect(src).toContain('never spaces adjacent to the cursor');
  });
});
