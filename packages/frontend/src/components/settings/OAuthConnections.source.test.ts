import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './OAuthConnections.tsx'), 'utf8');

describe('OAuthConnections response normalization', () => {
  it('never stores an undefined or object payload where the settings UI expects arrays', () => {
    expect(source).toContain("setConnections(Array.isArray(data) ? data : Array.isArray(data?.connections) ? data.connections : [])");
    expect(source).toContain("setSkillReadiness(Array.isArray(data) ? data : Array.isArray(data?.skills) ? data.skills : Array.isArray(data?.readiness) ? data.readiness : [])");
    expect(source).toContain('catch { setConnections([]); }');
    expect(source).toContain('catch { setSkillReadiness([]); }');
  });
});
