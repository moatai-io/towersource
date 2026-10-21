import fs from "fs";
import path from "path";
import { describe, it, expect } from "vitest";
const s = fs.readFileSync(
  path.resolve(import.meta.dirname, "./FilesWorkspace.tsx"),
  "utf8",
);
const projectFilesApi = fs.readFileSync(
  path.resolve(import.meta.dirname, "../../../../backend/routes/project-files/project-files-router.ts"),
  "utf8",
);
describe("file operations", () => {
  it("searches recursively", () => {
    expect(projectFilesApi).toContain("router.get('/files/search'");
    expect(s).toContain("workspace.searchProjectFiles");
  });
  it("renames deletes and moves", () => {
    for (const t of [
      "renameSelected",
      "deleteSelected",
      "moveSelected",
      "/api/files/rename",
      "/api/files/delete",
      "workspace.deleteMessage",
    ])
      expect(s).toContain(t);
  });
  it("downloads files and zip", () => {
    expect(s).toContain("fileServeUrl");
    expect(s).toContain("/api/files/download-zip-selected");
  });
  it("copies selected paths and short links with newline separation", () => {
    for (const t of [
      "copySelectedPaths",
      'paths.join("\\n")',
      "workspace.pathsCopied",
    ])
      expect(s).toContain(t);
  });
  it("records undo history", () => {
    for (const t of ["fileHistory", "workspace.recentActions", "workspace.undo"])
      expect(s).toContain(t);
  });
});

describe("direct context-menu moves", () => {
  it("moves the clicked entry without requiring selection mode and preserves selected groups", () => {
    expect(s).toContain("const moveSelected = async (paths: string[] = [...selectedPaths])");
    expect(s).toContain("const paths = selectedPaths.has(contextMenu.entry.path)");
    expect(s).toContain(": [contextMenu.entry.path]");
    expect(s).toContain("void moveSelected(paths)");
    expect(s).toContain("const moves = paths.map");
    expect(s).toContain("workspace.openFolder");
  });
  it("closes on cancellation and rejects sibling project prefixes", () => {
    expect(s).toContain("onClose={() => setMoveModalPaths(null)}");
    expect(s).toContain('!targetDir.startsWith(`${rootPath}/`)');
  });
  it("always exposes the sidebar move action with translated labels", () => {
    const tree = fs.readFileSync(path.resolve(import.meta.dirname, "FileTree.tsx"), "utf8");
    expect(tree).toContain("t('moveItemsTitle', { count: selectedCount })");
    expect(tree).toContain("`${t('moveToFolder')}…`, show: true");
    expect(tree).not.toContain("'Move to folder...'");
  });
});

 describe("folder picker integration", () => {
  it("uses the shared picker with project boundary and the existing mutation history", () => {
    expect(s).toContain("setMoveModalPaths(compactTopLevelPaths(paths))");
    expect(s).toContain("rootPath={rootPath}");
    expect(s).toContain("onMove={(targetDir) => moveToFolder(targetDir, moveModalPaths)}");
    expect(s).not.toContain("prompt({ title: t('workspace.moveTitle')");
    expect(s).toContain("workspace.movedHistory");
    const picker = fs.readFileSync(path.resolve(import.meta.dirname, "SelectionToolbar.tsx"), "utf8");
    expect(picker).toContain("await onMove(targetDir)");
    expect(picker).toContain("browsePath === rootPath");
  });
});
