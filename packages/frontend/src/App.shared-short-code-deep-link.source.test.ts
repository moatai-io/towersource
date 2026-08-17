import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(path.resolve(__dirname, 'App.tsx'), 'utf8');

describe('shared Session short-code deep links', () => {
  it('fetches an accessible Session by short code when it is absent from the local list', () => {
    expect(source).toContain('const res = await fetch(`${API_BASE}/sessions/${targetKey}`, { headers: h })');
    expect(source).not.toContain('UUID 만 shared session fetch');
    expect(source).not.toContain('short_code 는 내부 세션 식별용이라 로컬 목록에 *반드시* 있어야 함');
  });
});
