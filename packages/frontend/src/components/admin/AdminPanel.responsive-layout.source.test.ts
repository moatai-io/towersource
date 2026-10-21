import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, 'AdminPanel.tsx'), 'utf8');
const modelSource = fs.readFileSync(path.join(__dirname, 'model-management/ModelManagement.tsx'), 'utf8');
const modelSelectSource = fs.readFileSync(path.join(__dirname, 'ModelDefaultSelect.tsx'), 'utf8');

describe('AdminPanel responsive layout contract', () => {
  it('uses compact modal padding and a shrink-safe title', () => {
    expect(source).toContain('px-4 py-3 sm:px-6 sm:py-4');
    expect(source).toContain('min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:p-6');
    expect(source).toContain('max-h-[calc(100dvh-1rem)] sm:max-h-[92vh]');
    expect(source).toContain('truncate text-[18px] font-bold text-gray-100">{panelTitle}');
    expect(source).not.toContain('data-testid="personal-credentials-panel"');
  });

  it('keeps simplified model policy controls responsive', () => {
    expect(source).toContain('<AiSettingsManagement token={token} canEditReasoning={role === \'admin\' || role === \'operator\'} />');
    expect(modelSource).toContain('flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center');
    expect(modelSelectSource).toContain('w-full rounded-md border border-surface-600');
    expect(modelSelectSource).toContain('sm:w-[240px]');
  });

  it('keeps the team Connection form and cards responsive', () => {
    expect(source).toContain('grid gap-3 rounded-xl border border-primary-500/30');
    expect(source).toContain('md:grid-cols-2');
    expect(source).toContain('space-y-3');
  });
});
