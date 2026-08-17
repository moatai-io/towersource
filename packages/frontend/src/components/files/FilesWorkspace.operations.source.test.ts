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
    expect(s).toContain("Project 전체에서 파일명/경로 검색");
  });
  it("renames deletes and moves", () => {
    for (const t of [
      "renameSelected",
      "deleteSelected",
      "moveSelected",
      "/api/files/rename",
      "/api/files/delete",
      "되돌릴 수 없습니다",
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
      "개 경로 복사",
      "createTowerFileShortLink",
      "내부 링크 복사",
    ])
      expect(s).toContain(t);
  });
  it("records undo history", () => {
    for (const t of ["fileHistory", "최근 작업", "되돌리기"])
      expect(s).toContain(t);
  });
});
