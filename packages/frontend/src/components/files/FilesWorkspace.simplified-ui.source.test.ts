import fs from "fs";
import path from "path";
import { describe, it, expect } from "vitest";
const s = fs.readFileSync(
  path.resolve(import.meta.dirname, "./FilesWorkspace.tsx"),
  "utf8",
);
describe("simplified file workspace ui", () => {
  it("keeps add, search, and selection compact until requested", () => {
    expect(s).toContain("aria-label={t('workspace.add')}");
    expect(s).toContain("createMenuOpen");
    expect(s).toContain("searchOpen");
    expect(s).toContain("aria-label={searchOpen ? t('workspace.closeSearch') : t('workspace.search')}");
    expect(s).toContain("aria-label={selectionMode ? t('workspace.cancelSelection') : t('workspace.select')}");
    expect(s).toContain('className="hidden text-[12px] sm:inline"');
    expect(s).not.toContain("격자");
    expect(s).not.toContain("changeViewMode");
  });
  it("uses a mobile bottom sheet for the add menu", () => {
    expect(s).toContain("aria-label={t('workspace.closeAddMenu')}");
    expect(s).toContain('bottom-[max(12px,env(safe-area-inset-bottom))]');
  });
  it("creates files and folders inline without prompt", () => {
    for (const token of [
      "inlineCreate",
      "inlineCreateName",
      "submitCreate",
      "t('workspace.newFolder')",
      "t('workspace.newFile')",
      "t('workspace.create')",
    ])
      expect(s).toContain(token);
    expect(s).not.toContain("window." + "prompt(kind==='file'");
  });
  it("offers row context actions", () => {
    expect(s).toContain("onContextMenu");
    for (const token of ["t('workspace.expandCollapse')", "t('workspace.selectionActions')", "t('workspace.copyPath')"])
      expect(s).toContain(token);
  });
  it("uploads dropped files and folders to current path with feedback", () => {
    for (const token of [
      "readDroppedItems(event.dataTransfer)",
      "uploadItems",
      "currentPath",
      "dropActive",
      "t('workspace.dropHere')",
    ])
      expect(s).toContain(token);
  });
});
