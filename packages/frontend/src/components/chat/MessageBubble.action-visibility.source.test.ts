import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const component = readFileSync(new URL('./MessageBubble.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');

describe('message action visibility contract', () => {
  it('uses one semantic action class instead of breakpoint-bound hover utilities', () => {
    expect(component.match(/className="[^"]*message-actions/g)?.length).toBe(2);
    expect(component).not.toContain('md:group-hover/message:opacity-100');
    expect(component).not.toContain('md:pointer-events-none');
  });

  it('hides actions only when the browser reports precise hover input', () => {
    expect(css).toContain('@media (min-width: 48rem) and (hover: hover) and (pointer: fine)');
    expect(css).toMatch(/\.message-actions\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?pointer-events:\s*auto;/);
    expect(css).toMatch(/\.group\\\/message \.message-actions\s*\{[\s\S]*?opacity:\s*0;[\s\S]*?pointer-events:\s*none;/);
    expect(css).toMatch(/\.group\\\/message:hover \.message-actions,[\s\S]*?\.group\\\/message:focus-within \.message-actions\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?pointer-events:\s*auto;/);
  });
});
