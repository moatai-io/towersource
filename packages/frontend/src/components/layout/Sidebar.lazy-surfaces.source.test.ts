import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8');
const filesSurface = readFileSync(new URL('./SidebarFilesSurface.tsx', import.meta.url), 'utf8');

describe('Sidebar inactive surface boundaries', () => {
  it('keeps files, pins, and prompts helpers out of the initial sessions chunk', () => {
    expect(source).toContain("const LazyPinList = React.lazy(() => import('../pinboard/PinList')");
    expect(source).toContain("const LazyPromptItem = React.lazy(() => import('../prompts/PromptItem')");
    expect(source).not.toContain("import { PinList } from '../pinboard/PinList'");
    expect(source).not.toContain("import { PromptItem as PromptItemComponent } from '../prompts/PromptItem'");
    expect(source).toContain("import('./SidebarFilesSurface')");
    expect(source).not.toContain("from './SessionFilesMenuSection'");
    expect(filesSurface).toContain("from './SessionFilesMenuSection'");
  });
});
