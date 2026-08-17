import fs from "fs";
import path from "path";
import { describe, it, expect } from "vitest";
const s = fs.readFileSync(
  path.resolve(import.meta.dirname, "./FilesWorkspace.tsx"),
  "utf8",
);
describe("simplified file workspace ui", () => {
  it("keeps add, search, and selection compact until requested", () => {
    expect(s).toContain('aria-label="추가"');
    expect(s).toContain("createMenuOpen");
    expect(s).toContain("searchOpen");
    expect(s).toContain('aria-label={searchOpen ? "검색 닫기" : "검색"}');
    expect(s).toContain('aria-label={selectionMode ? "선택 취소" : "선택"}');
    expect(s).toContain('className="hidden text-[12px] sm:inline"');
    expect(s).not.toContain("격자");
    expect(s).not.toContain("changeViewMode");
  });
  it("uses a mobile bottom sheet for the add menu", () => {
    expect(s).toContain('aria-label="추가 메뉴 닫기"');
    expect(s).toContain('bottom-[max(12px,env(safe-area-inset-bottom))]');
  });
  it("creates files and folders inline without prompt", () => {
    for (const token of [
      "inlineCreate",
      "inlineCreateName",
      "submitCreate",
      "새 폴더",
      "새 파일",
      "만들기",
    ])
      expect(s).toContain(token);
    expect(s).not.toContain("window." + "prompt(kind==='file'");
  });
  it("offers row context actions", () => {
    expect(s).toContain("onContextMenu");
    for (const token of ["펼치기 / 접기", "선택 작업", "경로 복사"])
      expect(s).toContain(token);
  });
  it("uploads dropped files and folders to current path with feedback", () => {
    for (const token of [
      "readDroppedItems(event.dataTransfer)",
      "uploadItems",
      "currentPath",
      "dropActive",
      "현재 폴더에 파일·폴더 놓기",
    ])
      expect(s).toContain(token);
  });
});
