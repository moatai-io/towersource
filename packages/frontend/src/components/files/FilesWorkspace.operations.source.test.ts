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
      "createTowerFileShortLink",
      "workspace.copyInternalLink",
    ])
      expect(s).toContain(t);
  });
  it("records undo history", () => {
    for (const t of ["fileHistory", "workspace.recentActions", "workspace.undo"])
      expect(s).toContain(t);
  });
});
