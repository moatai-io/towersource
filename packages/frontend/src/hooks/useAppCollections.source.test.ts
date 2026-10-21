import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const collections = readFileSync(new URL('./useAppCollections.ts', import.meta.url), 'utf8');

describe('App collection handlers ownership', () => {
  it('keeps App on hook wiring and editor rendering', () => {
    expect(app).toContain('useAppCollections({ token, requestFile, requestFileTree, t })');
    expect(app).toContain('{promptEditorOpen ? (');
    expect(app).toContain('onClose={closePromptEditor}');
    expect(app).not.toContain('// ───── Pin handlers ─────');
    expect(app).not.toContain('// ───── Prompt handlers ─────');
  });

  it('preserves pin duplicate protection, folder navigation, and HTTP fallback', () => {
    expect(collections).toContain("pins.find((pin) => pin.file_path === filePath)");
    expect(collections).toContain("setSidebarTab('files')");
    expect(collections).toContain('requestFile(pin.file_path)');
    expect(collections).toContain('openMobileContext()');
  });

  it('preserves prompt preview and mutable user prompt CRUD', () => {
    expect(collections).toContain('path: `prompt:${prompt.title}`');
    expect(collections).toContain("typeof editingPrompt.id === 'number'");
    expect(collections).toContain("method: 'PATCH'");
    expect(collections).toContain("method: 'POST'");
    expect(collections).toContain("method: 'DELETE'");
    expect(collections).toContain("if (typeof id !== 'number') return;");
  });
});
