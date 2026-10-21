import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './FilesWorkspace.tsx'), 'utf8');

describe('FilesWorkspace mobile Agent scope', () => {
  it('shows one owning Agent selector and suppresses the duplicate project selector on mobile', () => {
    expect(source).toContain("t('workspace.currentDocumentWorkspace')");
    expect(source).toContain('<AgentIdentityAvatar project={selectedProject}');
    expect(source).toContain("aria-label={t('workspace.selectAiTeammateForDocuments')}");
    expect(source).toContain('{!embedded && !isMobile && (');
    expect(source).toContain('{project.agent?.displayName || project.name}');
  });

  it('uses a name-first two-column file list on mobile', () => {
    expect(source).toContain('grid-cols-[minmax(0,1fr)_72px]');
    expect(source).toContain('sm:grid-cols-[minmax(0,1fr)_90px_100px_126px]');
    expect(source).toContain('(isMobile ? 4 : 22)');
    expect(source).toContain('hidden text-[12px] text-surface-500 sm:block');
  });

  it('keeps the capability project aligned with initial and explicit workspace selection', () => {
    const initialSelectionStart = source.indexOf('const preferred =');
    const initialSelection = source.slice(initialSelectionStart, source.indexOf('useEffect(() => {', initialSelectionStart));
    expect(initialSelection).toContain('setSelectedProjectId(preferred.id)');
    expect(initialSelection).toContain('setCapabilityProjectId(preferred.id)');

    const switchProject = source.slice(source.indexOf('const switchProject ='), source.indexOf('const openProjectInstructions'));
    expect(switchProject).toContain('setCapabilityProjectId(project.id)');
    expect(switchProject).toContain('setLibraryView("all")');
    expect(switchProject).toContain('setExpandedPaths(new Set())');
    expect(switchProject).toContain('clearSelection()');
    expect(switchProject).toContain('setCurrentPath(project.rootPath || "")');
  });
});
