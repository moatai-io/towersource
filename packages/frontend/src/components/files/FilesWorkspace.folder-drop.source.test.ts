import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  path.resolve(import.meta.dirname, "./FilesWorkspace.tsx"),
  "utf8",
);

describe("FilesWorkspace folder row drop", () => {
  it("accepts operating-system files on a folder row", () => {
    expect(source).toContain('event.dataTransfer.types.includes("Files")');
    expect(source).toContain("uploadItems(items, entry.path)");
    expect(source).toContain(
      'event.dataTransfer.dropEffect = isInternalMove ? "move" : "copy"',
    );
  });

  it("keeps folder-row drops from reaching the current-folder drop zone", () => {
    expect(source).toContain("event.stopPropagation()");
    expect(source).toContain("setDropActive(false)");
  });

  it("shows the exact target folder instead of a full-screen-only selection", () => {
    expect(source).toContain("t('workspace.dropInThisFolder')");
    expect(source).toContain("ring-2 ring-inset ring-primary-500/70");
    expect(source).toContain("t('workspace.dropFilesOnFolder', { name: entry.name })");
  });

  it("uploads to an explicit target and refreshes the affected tree", () => {
    expect(source).toContain("targetPath = currentPath");
    expect(source).toContain("uploadDroppedFiles(targetPath, items, setUploadProgress)");
    expect(source).toContain("affectedDirectories: [targetPath]");
    expect(source).toContain("await refreshDirectories(affectedDirectories)");
  });
});
