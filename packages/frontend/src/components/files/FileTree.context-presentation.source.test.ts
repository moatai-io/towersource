import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  path.resolve(import.meta.dirname, "./FileTree.tsx"),
  "utf8",
);

describe("FileTree context menu presentation", () => {
  it("keeps mouse contextmenu pointer-anchored on hybrid touch laptops", () => {
    expect(source).toContain("presentation: 'pointer' | 'sheet'");
    expect(source).toContain("presentation: 'pointer' });");
    expect(source).toContain("presentation: 'sheet' });");
    expect(source).toContain("mobile={contextMenu.presentation === 'sheet'}");
    expect(source).not.toContain("mobile={isTouchDevice.current}");
  });
});
