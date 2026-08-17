import fs from "fs";
import path from "path";
import { describe, it, expect } from "vitest";
const s = fs.readFileSync(
  path.resolve(import.meta.dirname, "./FilesWorkspace.tsx"),
  "utf8",
);
describe("file selection mode", () => {
  it("shows checkbox only in explicit mode", () => {
    expect(s).toContain(
      'selectionMode ? "opacity-100" : "pointer-events-none opacity-0"',
    );
    expect(s).not.toContain("group-hover:opacity-100");
  });
  it("supports escape and modifier click", () => {
    for (const t of [
      'event.key === "Escape"',
      "event?.metaKey",
      "event?.ctrlKey",
      "activateEntry(entry, event)",
    ])
      expect(s).toContain(t);
  });
  it("keeps inline folder expansion and safe parent navigation", () => {
    for (const t of [
      "void toggleFolder(entry)",
      "await loadDirectory(entry.path, false)",
      "↑ 상위 폴더",
      'if (parentPath === rootPath) setLibraryView("all")',
    ])
      expect(s).toContain(t);
    expect(s).not.toContain("setCurrentPath(entry.path)");
  });
});
