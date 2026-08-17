import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./FileActionsMenu.tsx", import.meta.url),
  "utf8",
);

describe("FileActionsMenu source contracts", () => {
  it("portals the menu above scroll and viewer overflow containers", () => {
    expect(source).toContain('import { createPortal } from "react-dom"');
    expect(source).toContain('className="fixed z-[100]');
    expect(source).toContain("document.body");
    expect(source).toContain("getBoundingClientRect()");
    expect(source).toContain("aria-expanded={open}");
    expect(source).toContain('aria-haspopup="menu"');
    expect(source).toContain('role="menu"');
  });

  it("keeps stateful controls mounted when the menu closes", () => {
    expect(source).toContain("hidden={!open}");
    expect(source).not.toContain("{open &&");
    expect(source).not.toContain('onClick={() => setOpen(false)}');
  });

  it("closes on outside pointer and Escape while tracking viewport changes", () => {
    expect(source).toContain(
      'document.addEventListener("pointerdown", closeOnOutsidePointer)',
    );
    expect(source).toContain(
      'document.addEventListener("keydown", closeOnEscape)',
    );
    expect(source).toContain(
      'window.addEventListener("resize", updatePosition)',
    );
    expect(source).toContain(
      'window.addEventListener("scroll", updatePosition, true)',
    );
  });
});
