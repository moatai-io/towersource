import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const home = fs.readFileSync(path.resolve(import.meta.dirname, './AITeamHome.tsx'), 'utf8');
const styles = fs.readFileSync(path.resolve(import.meta.dirname, '../../index.css'), 'utf8');

describe('AI Team quiet control room visual contract', () => {
  it('uses one hero with an integrated divided stats row instead of four stat cards', () => {
    expect(home).toContain('ai-team-control-room');
    expect(home).toContain('ai-team-hero');
    expect(home).toContain('ai-team-stats');
    expect(home).toContain('ai-team-stat');
    expect(home).not.toContain('mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4');
  });

  it('uses dedicated semantic surfaces for people operations and teammate cards', () => {
    expect(home).toContain('ai-team-people-ops');
    expect(home).toContain('ai-team-member-card');
    expect(home).toContain('ai-team-primary-action');
  });

  it('defines a light-first neutral canvas and restrained two-layer depth', () => {
    expect(styles).toContain(':root[data-theme="light"] .ai-team-control-room');
    expect(styles).toContain('--ai-team-canvas: #f7faf9');
    expect(styles).toContain('0 1px 2px var(--ai-team-shadow-contact)');
    expect(styles).toContain('0 16px 36px var(--ai-team-shadow-space)');
  });
});
