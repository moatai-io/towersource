import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  path.resolve(import.meta.dirname, "./FilesWorkspace.tsx"),
  "utf8",
);

describe("FilesWorkspace row context creation", () => {
  it("can create a file or folder inside the right-clicked folder, not only current root", () => {
    expect(source).toContain("inlineCreateTargetPath");
    expect(source).toContain('beginCreate("folder", contextMenu.entry.path)');
    expect(source).toContain('beginCreate("file", contextMenu.entry.path)');
    expect(source).toContain(
      "const targetDir = inlineCreateTargetPath || currentPath",
    );
    expect(source).toContain("await runFileMutation({");
    expect(source).toContain("affectedDirectories: [targetDir]");
  });

  it("shows folder-specific context actions in the Files workspace menu", () => {
    for (const key of [
      'workspace.newFolderHere',
      'workspace.newFileHere',
      'moveToFolder',
      'workspace.copyPath',
    ]) {
      expect(source).toContain(key);
    }
  });
});
