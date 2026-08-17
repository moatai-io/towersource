import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const sourceRoot = path.resolve(import.meta.dirname);
const targets = [
  'components/admin/AdminPanel.tsx',
  'components/agents/AgentHomeOverview.tsx',
  'components/auth/LoginPage.tsx',
  'components/files/FileTree.tsx',
  'components/layout/Sidebar.tsx',
  'features/file-exchange/FileExchangeDropTarget.tsx',
  'features/file-exchange/FileExchangeSurface.tsx',
  'locales/ko/admin.json',
];

const sources = targets.map(relativePath => ({
  relativePath,
  source: fs.readFileSync(path.join(sourceRoot, relativePath), 'utf8'),
}));

describe('dynamic Korean copy regression', () => {
  it('does not expose parenthesized object particles in the audited UI copy', () => {
    for (const { relativePath, source } of sources) {
      expect(source, relativePath).not.toContain('을(를)');
    }
  });

  it('uses a pronunciation-independent label for agent conversation actions', () => {
    const sidebar = sources.find(item => item.relativePath.endsWith('Sidebar.tsx'))!.source;
    expect(sidebar).toContain("t('startNewConversationWith', { name: project.agent?.displayName || project.name })");
    expect(sidebar).not.toContain('${project.agent?.displayName || project.name}와 새 대화');
  });
});
