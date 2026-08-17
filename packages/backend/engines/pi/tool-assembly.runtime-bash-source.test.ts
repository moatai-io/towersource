import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './tool-assembly.ts'), 'utf8');

describe('Project authority-routed bash assembly policy', () => {
  it('hides native host bash whenever the Project execution plane is active', () => {
    expect(source).toContain('const hostBashEnabled = !runtimeBoxEnabled');
    expect(source).toContain('AI에는 bash 하나만 보인다');
    expect(source).toContain('native host bash를 숨기고');
    expect(source).toContain('Project authority에 맞는 Worker/compat executor');
  });

  it('keeps credential-dependent Project commands on the Project execution plane', () => {
    expect(source).toContain('Credential-dependent Project commands therefore always stay on the Project execution plane');
    expect(source).toContain("hostBash=${hostBashEnabled ? 'enabled' : 'hidden-project-runtime'}");
  });
});
