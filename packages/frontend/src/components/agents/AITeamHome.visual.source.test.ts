import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const home = fs.readFileSync(path.resolve(import.meta.dirname, './AITeamHome.tsx'), 'utf8');
const styles = fs.readFileSync(path.resolve(import.meta.dirname, '../../index.css'), 'utf8');

describe('AI teammate management visual contract', () => {
  it('uses one restrained directory hero instead of a work metrics dashboard', () => {
    expect(home).toContain('ai-team-control-room');
    expect(home).toContain('ai-team-hero');
    expect(home).not.toContain('ai-team-stats');
    expect(home).not.toContain('ai-team-stat');
    expect(home).not.toContain('dailyTurns');
  });

  it('uses compact teammate cards, larger identity images, and a single primary creation action', () => {
    expect(home).toContain('ai-team-member-card');
    expect(home).toContain('h-20 w-20');
    expect(home).toContain('grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))]');
    expect(home).not.toContain('min-h-52');
    expect(home).toContain('ai-team-primary-action');
    expect(home).not.toContain('ai-team-people-ops');
  });

  it('defines a light-first neutral canvas and restrained two-layer depth', () => {
    expect(styles).toContain(':root[data-theme="light"] .ai-team-control-room');
    expect(styles).toContain('--ai-team-canvas: #f7faf9');
    expect(styles).toContain('0 1px 2px var(--ai-team-shadow-contact)');
    expect(styles).toContain('0 16px 36px var(--ai-team-shadow-space)');
  });
});
