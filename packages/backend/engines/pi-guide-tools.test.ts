import { describe, expect, it } from 'vitest';
import path from 'path';
import { createRuntimeGuideListTool, createRuntimeGuideReadTool, listRuntimeGuideResources, resolveRuntimeGuideResourcePath } from './pi-guide-tools.js';

function readText(result: any): string {
  return result?.content?.[0]?.text || '';
}

describe('Pi runtime guide resource tools', () => {
  it('uses Responses-compatible underscore tool names', () => {
    const tools = [createRuntimeGuideListTool({ userRole: 'member' }), createRuntimeGuideReadTool({ userRole: 'member' })];
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(tool.name).not.toContain('.');
    }
    expect(tools.map((tool) => tool.name)).toEqual(['runtime_guide_list', 'runtime_guide_read']);
  });

  it('lists role-visible runtime guide metadata without full content', async () => {
    const tool = createRuntimeGuideListTool({ userRole: 'member' });
    const result = await (tool as any).execute('call-1', {});
    const parsed = JSON.parse(readText(result));

    expect(parsed.total).toBe(8);
    expect(parsed.guides.map((guide: any) => guide.name)).toEqual(['visualization', 'publishing', 'git', 'agent-orchestration', 'pdf-export', 'pdf-analysis', 'spreadsheet-analysis', 'cad-analysis']);
    expect(parsed.guides[0]).toMatchObject({
      name: 'visualization',
      title: 'Tower Visualization Guide',
      minRole: 'viewer',
    });
    expect(parsed.guides[4]).toMatchObject({
      name: 'pdf-export',
      title: 'Tower PDF Export Guide',
      minRole: 'member',
    });
    expect(parsed.guides[7]).toMatchObject({
      name: 'cad-analysis',
      title: 'Tower CAD Analysis Guide',
      minRole: 'member',
    });
    for (const guide of parsed.guides) {
      expect(guide.content).toBeUndefined();
    }
  });

  it('filters runtime guides by role for list and read', async () => {
    const listTool = createRuntimeGuideListTool({ userRole: 'viewer' });
    const listed = JSON.parse(readText(await (listTool as any).execute('call-list', {})));
    expect(listed.guides.map((guide: any) => guide.name)).toEqual(['visualization']);

    const readTool = createRuntimeGuideReadTool({ userRole: 'viewer' });
    const denied = await (readTool as any).execute('call-denied', { name: 'publishing' });
    expect(denied.isError).toBe(true);
    expect(readText(denied)).toContain('not visible');
  });

  it('resolves guide resources from source and compiled dist locations', () => {
    const sourceStart = path.join(process.cwd(), 'packages', 'backend', 'engines');
    const compiledStart = path.join(process.cwd(), 'dist', 'backend', 'packages', 'backend', 'engines');

    expect(resolveRuntimeGuideResourcePath('docs/tower-guide/resources/visualization.md', [sourceStart]))
      .toBe(path.join(process.cwd(), 'docs', 'tower-guide', 'resources', 'visualization.md'));
    expect(resolveRuntimeGuideResourcePath('docs/tower-guide/resources/visualization.md', [compiledStart]))
      .toBe(path.join(process.cwd(), 'docs', 'tower-guide', 'resources', 'visualization.md'));
  });

  it('reads the full visualization guide resource', async () => {
    const tool = createRuntimeGuideReadTool({ userRole: 'member' });
    const result = await (tool as any).execute('call-2', { name: 'visualization' });
    const parsed = JSON.parse(readText(result));

    expect(parsed.name).toBe('visualization');
    expect(parsed.content).toContain('Tower Visualization Guide Resource');
    expect(parsed.content).toContain('```mermaid');
    expect(parsed.content).toContain('JSON must be strictly valid');
  });

  it('aligns discovery metadata, injected guidelines, and guide content without losing detailed rules', async () => {
    const metadata = listRuntimeGuideResources().find(guide => guide.name === 'visualization')!;
    const tool = createRuntimeGuideReadTool({ userRole: 'member' }) as any;
    const { content } = JSON.parse(readText(await tool.execute('consistency', { name: 'visualization' })));
    for (const text of [metadata.description, tool.promptGuidelines.join('\n'), content]) {
      expect(text).toContain('Basic Mermaid flowcharts using the shared core rules do not require a guide read');
      expect(text).not.toContain('Read before producing chart, mermaid');
      expect(text).not.toContain('before relying on exact schemas or Mermaid edge/label rules');
    }
    expect(content).toContain('via `runtime_guide_read`');
    expect(content).not.toContain('via `guide_read`');
    expect(content).toContain('FLOWCHART LABELS');
    expect(content).not.toContain('Applies to ALL shapes');
    expect(content).toContain('Plain-text children must NOT be quoted');
    expect(content).toContain('NEVER `-.x.->`');
    expect(content).toContain('row data goes in the "data" field, NOT "rows"');
    expect(content).toContain('the inner array MUST close before the outer object');
    expect(content).toContain('Allowed exceptions (low contrast risk)');
    expect(content).toContain('credential_vault_input');
    expect(content).toContain('accepts an offer to open secure input');
    expect(content).not.toContain('**```secure-input**');
    expect(content).not.toContain('"target": ".env"');
  });

  it('reads the full publishing guide resource', async () => {
    const tool = createRuntimeGuideReadTool({ userRole: 'member' });
    const result = await (tool as any).execute('call-3', { name: 'publishing' });
    const parsed = JSON.parse(readText(result));

    expect(parsed.name).toBe('publishing');
    expect(parsed.content).toContain('Tower Publishing Guide Resource');
    expect(parsed.content).toContain('publish_site');
    expect(parsed.content).toContain('localhost');
  });

  it('reads the full git guide resource', async () => {
    const tool = createRuntimeGuideReadTool({ userRole: 'member' });
    const result = await (tool as any).execute('call-4', { name: 'git' });
    const parsed = JSON.parse(readText(result));

    expect(parsed.name).toBe('git');
    expect(parsed.content).toContain('Tower Git / PR Guide Resource');
    expect(parsed.content).toContain('Tower-Session');
    expect(parsed.content).toContain('git stash');
  });

  it('reads the full agent orchestration guide resource', async () => {
    const tool = createRuntimeGuideReadTool({ userRole: 'member' });
    const result = await (tool as any).execute('call-5', { name: 'agent-orchestration' });
    const parsed = JSON.parse(readText(result));

    expect(parsed.name).toBe('agent-orchestration');
    expect(parsed.content).toContain('Tower Agent Orchestration Guide Resource');
    expect(parsed.content).toContain('persistent_agent_create');
    expect(parsed.content).toContain('SPAWN_QUOTA_EXCEEDED');
  });

  it('reads the full pdf export guide resource', async () => {
    const tool = createRuntimeGuideReadTool({ userRole: 'member' });
    const result = await (tool as any).execute('call-6', { name: 'pdf-export' });
    const parsed = JSON.parse(readText(result));

    expect(parsed.name).toBe('pdf-export');
    expect(parsed.content).toContain('Tower PDF Export Guide Resource');
    expect(parsed.content).toContain('print-ready HTML');
    expect(parsed.content).toContain('verification');
  });

  it('reads the full PDF analysis guide resource', async () => {
    const tool = createRuntimeGuideReadTool({ userRole: 'member' });
    const result = await (tool as any).execute('call-7', { name: 'pdf-analysis' });
    const parsed = JSON.parse(readText(result));

    expect(parsed.name).toBe('pdf-analysis');
    expect(parsed.content).toContain('Tower PDF Analysis Guide Resource');
    expect(parsed.content).toContain('pdf_view');
    expect(parsed.content).toContain('pdf_read');
  });

  it('reads the full spreadsheet analysis guide resource', async () => {
    const tool = createRuntimeGuideReadTool({ userRole: 'member' });
    const result = await (tool as any).execute('call-8', { name: 'spreadsheet-analysis' });
    const parsed = JSON.parse(readText(result));

    expect(parsed.name).toBe('spreadsheet-analysis');
    expect(parsed.content).toContain('Tower Spreadsheet Analysis Guide Resource');
    expect(parsed.content).toContain('excel_read');
    expect(parsed.content).toContain('excel_query');
  });

  it('reads the full CAD analysis guide resource', async () => {
    const tool = createRuntimeGuideReadTool({ userRole: 'member' });
    const result = await (tool as any).execute('call-9', { name: 'cad-analysis' });
    const parsed = JSON.parse(readText(result));

    expect(parsed.name).toBe('cad-analysis');
    expect(parsed.content).toContain('Tower CAD Analysis Guide Resource');
    expect(parsed.content).toContain('cad_view');
    expect(parsed.content).toContain('DXF');
  });

  it('has a stable runtime guide resource catalog', () => {
    expect(listRuntimeGuideResources().map((guide) => guide.name)).toEqual(['visualization', 'publishing', 'git', 'agent-orchestration', 'pdf-export', 'pdf-analysis', 'spreadsheet-analysis', 'cad-analysis']);
  });
});
