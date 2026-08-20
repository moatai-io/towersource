import fs from "fs";
import path from "path";
import { describe, it, expect } from "vitest";
const s = fs.readFileSync(
  path.resolve(import.meta.dirname, "./FilesWorkspace.tsx"),
  "utf8",
);
describe("embedded file workspace parity", () => {
  it("supports file folder picker and drag-drop uploads", () => {
    for (const t of [
      "t('workspace.uploadFiles')",
      "t('workspace.uploadFolder')",
      "webkitdirectory",
      "multiple",
      "readDroppedItems",
      "uploadDroppedFiles",
    ])
      expect(s).toContain(t);
  });
  it("creates entries inline and refreshes", () => {
    for (const t of [
      'beginCreate("folder")',
      "submitCreate",
      "/api/files/mkdir",
      "runFileMutation",
      "refreshDirectories",
    ])
      expect(s).toContain(t);
    expect(s).not.toContain("window." + "prompt(kind");
  });
  it("supports bulk selection and ACL-checked project copies", () => {
    for (const t of [
      "selectedPaths",
      "t('workspace.selectAiTeammateToSend')",
      "t('workspace.copyAndSend')",
      "transferFile",
      '{ scope: "project", projectId: selectedProject.id, relativePath }',
      '{ scope: "project", projectId: target.id, relativeDirectory: "uploads" }',
    ])
      expect(s).toContain(t);
    expect(s).not.toContain("symlink");
  });
  it("uses shared resumable uploader", () => {
    expect(s).toContain("../../utils/folder-drop");
    expect(s).toContain("busyAction");
  });
});
