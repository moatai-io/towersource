import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(new URL('./AgentNavigationRail.tsx', import.meta.url), 'utf8');

describe('Collapsed agent rail temporary expansion', () => {
  it('reveals the full rail on hover or keyboard focus without changing saved expansion', () => {
    expect(source).toContain('const visuallyExpanded = expanded || hoverExpanded;');
    expect(source).toContain("const labelVisibility = visuallyExpanded ? 'opacity-100' : 'opacity-0'");
    expect(source).toContain('onMouseEnter={() => setHoverExpanded(true)}');
    expect(source).toContain('onFocus={() => setHoverExpanded(true)}');
    expect(source).toContain('onMouseLeave={() => setHoverExpanded(false)}');
    expect(source).toContain('event.currentTarget.contains(event.relatedTarget)');
    expect(source).toContain("event.key === 'Escape'");
    expect(source).not.toContain('createPortal');
  });
  it('overlays the adjacent column instead of shifting the session list', () => {
    expect(source).toContain('width: visuallyExpanded ? width : 56');
    expect(source).toContain('marginRight: !expanded && hoverExpanded ? -(width - 56) : 0');
    expect(source).toContain('z-30 shadow-xl');
    expect(source).toContain('onClick={onToggleExpanded}');
  });
});
