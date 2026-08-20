import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = path.resolve(import.meta.dirname, '../..');
const mainSource = fs.readFileSync(path.join(sourceRoot, 'main.tsx'), 'utf8');
const voiceLabSource = fs.readFileSync(path.join(sourceRoot, 'features/voice-lab/VoiceLabPage.tsx'), 'utf8');
const devHostsSource = fs.readFileSync(path.join(sourceRoot, 'config/dev-hosts.ts'), 'utf8');
const combined = [mainSource, voiceLabSource, devHostsSource].join('\n');

describe('Voice Lab dev host gate source contract', () => {
  it('centralizes host gating through config/dev-hosts', () => {
    expect(mainSource).toContain("import { isAllowedDevHost } from './config/dev-hosts'");
    expect(voiceLabSource).toContain("import { isAllowedDevHost } from '../../config/dev-hosts'");
    expect(mainSource).toContain('isAllowedDevHost(window.location.hostname)');
    expect(voiceLabSource).toContain('isAllowedDevHost(window.location.hostname)');
  });

  it('does not hard-code private deployment domains in frontend source', () => {
    expect(combined).not.toMatch(/moatai\.app|moatai\.io/);
    expect(combined).toContain('VITE_TOWER_DEV_HOSTS');
  });
});
