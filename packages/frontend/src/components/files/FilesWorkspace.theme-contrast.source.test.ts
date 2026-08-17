import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  path.resolve(import.meta.dirname, "./FilesWorkspace.tsx"),
  "utf8",
);

describe("Files workspace theme contrast", () => {
  it("uses theme semantic text colors for inactive library tabs and hover", () => {
    expect(source).toContain(
      "border-transparent text-surface-500 hover:border-surface-700 hover:bg-surface-900 hover:text-surface-100",
    );
    expect(source).not.toContain(
      "hover:text-surface-950 dark:hover:text-surface-100",
    );
  });

  it("uses the same semantic hover contract for the hidden-files control", () => {
    expect(source).toContain(
      "border-surface-800 bg-surface-900/80 text-surface-500 hover:border-surface-700 hover:bg-surface-900 hover:text-surface-100",
    );
    expect(source).not.toContain(
      "hover:text-surface-950 dark:hover:text-gray-200",
    );
  });
});
