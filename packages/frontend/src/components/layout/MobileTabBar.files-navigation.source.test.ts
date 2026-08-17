import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './MobileTabBar.tsx'), 'utf8');

describe('mobile Files navigation', () => {
  it('opens the current project file tree instead of the full management workspace', () => {
    const filesBranch = source.slice(source.indexOf("} else if (tab === 'files')"), source.indexOf('\n    }\n  };', source.indexOf("} else if (tab === 'files')")));
    expect(filesBranch).toContain('setMobileFilesNavigationSurface()');
    expect(filesBranch).not.toContain("setSidebarTab('files')");
    expect(filesBranch).not.toContain("setActiveView('chat')");
    expect(filesBranch).not.toContain('setSidebarOpen(true)');
    expect(filesBranch).not.toContain("setActiveView('projectFiles')");
    expect(filesBranch).toContain("projects.find((project) => project.rootPath && !project.archived)");
    expect(filesBranch).not.toContain('setAiNavigationSurface()');
  });
});
