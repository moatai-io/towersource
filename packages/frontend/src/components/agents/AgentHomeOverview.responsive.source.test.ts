import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const home = fs.readFileSync(path.resolve(import.meta.dirname, './AgentHomeOverview.tsx'), 'utf8');
const styles = fs.readFileSync(path.resolve(import.meta.dirname, '../../index.css'), 'utf8');

describe('Agent Home narrow pane responsiveness', () => {
  it('marks the profile hero as a container-responsive layout', () => {
    expect(home).toContain('agent-home-profile-card');
    expect(home).toContain('agent-home-profile-layout');
    expect(home).toContain('agent-home-profile-actions');
    expect(home).toContain('agent-home-profile-name');
  });

  it('keeps the three profile actions in one compact vertical stack', () => {
    expect(home).toContain('grid w-full grid-cols-1 gap-2');
    expect(styles).toContain('width: 9rem');
    expect(styles).toContain('.agent-home-profile-actions > * { width: 100%; }');
  });

  it('moves actions below the identity before the name becomes a narrow column', () => {
    expect(styles).toContain('.agent-home-profile-card { container-type: inline-size; }');
    expect(styles).toContain('@container (max-width: 720px)');
    expect(styles).toContain('.agent-home-profile-layout { grid-template-columns: minmax(0, 1fr); }');
  });

  it('stacks actions and preserves readable name wrapping in very narrow panes', () => {
    expect(styles).toContain('@container (max-width: 430px)');
    expect(styles).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(styles).toContain('overflow-wrap: anywhere');
    expect(styles).toContain('word-break: normal');
  });
});
