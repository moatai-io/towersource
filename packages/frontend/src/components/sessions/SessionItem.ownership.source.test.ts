import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './SessionItem.tsx'), 'utf8');

describe('SessionItem owner presentation', () => {
  it('shows the owner label consistently without adding a separate ownership accent', () => {
    expect(source).toContain('const ownerUsername = session.projectId && session.ownerUsername');
    expect(source).toContain('{ownerLabel}');
    expect(source).not.toContain('data-session-owner');
    expect(source).not.toContain('isOwnedByCurrentUser');
  });

  it('preserves the existing unread title weight and completed indicator', () => {
    expect(source).toContain('rowState.bold ? "font-bold text-gray-100" : "font-medium"');
    expect(source).toContain('rowState.indicator.kind === "done"');
  });
});
