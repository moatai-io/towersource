import { describe, expect, it } from 'vitest';
import en from './en';
import ko from './ko';

function flatten(value: unknown, prefix = ''): Record<string, string> {
  if (typeof value === 'string') return { [prefix]: value };
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) =>
    Object.entries(flatten(child, prefix ? `${prefix}.${key}` : key))));
}
const english = flatten(en);
const korean = flatten(ko);
const placeholders = (value: string) => [...value.matchAll(/{{\s*([^}]+?)\s*}}/g)].map(match => match[1]).sort();

describe('Korean locale integrity', () => {
  it('keeps all English and Korean translation keys aligned', () => {
    expect(Object.keys(korean).sort()).toEqual(Object.keys(english).sort());
  });
  it('preserves interpolation placeholders in each translation', () => {
    for (const [key, value] of Object.entries(english)) {
      expect(placeholders(korean[key] ?? ''), key).toEqual(placeholders(value));
    }
  });
  it('does not introduce blank Korean messages except the intentional sentence prefix', () => {
    expect(Object.entries(korean).filter(([, value]) => !value.trim()).map(([key]) => key))
      .toEqual(['admin.promptDefaultApplyBefore']);
  });
});
