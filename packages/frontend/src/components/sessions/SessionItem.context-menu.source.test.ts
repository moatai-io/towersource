import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './SessionItem.tsx'), 'utf8');

describe('SessionItem context menu positioning', () => {
  it('portals the fixed context menu to document.body', () => {
    expect(source).toContain(`import { createPortal } from "react-dom";`);
    expect(source).toContain('return createPortal(');
    expect(source).toContain('document.body,');
  });

  it('keeps pointer coordinates and viewport edge correction', () => {
    expect(source).toContain(`setCtxMenu({ x: e.clientX, y: e.clientY, presentation: "pointer" });`);
    expect(source).toContain('window.innerWidth - rect.width - pad');
    expect(source).toContain('window.innerHeight - rect.height - pad');
  });

  it('anchors the action button menu on desktop and uses a sheet only in the mobile layout', () => {
    expect(source).toContain(`presentation: "pointer" | "sheet"`);
    expect(source).toContain('const rect = e.currentTarget.getBoundingClientRect();');
    expect(source).toContain(`presentation: isMobile ? "sheet" : "pointer"`);
    expect(source).toContain(`mobile={ctxMenu.presentation === "sheet"}`);
    expect(source).not.toContain('mobile={isTouchDevice.current}');
  });

  it('does not expose the legacy project metadata move action', () => {
    expect(source).not.toContain('SessionProjectSubmenu');
    expect(source).not.toContain('t("moveToProject")');
    expect(source).not.toContain('t("addToProject")');
    expect(source).not.toContain('t("removeFromProject")');
  });

  it('does not expose the retired long-context toggle or its model mutation wiring', () => {
    expect(source).not.toContain('t("useLongContext")');
    expect(source).not.toContain('t("restoreNormalContext")');
    expect(source).not.toContain('onToggleLongContext');
    expect(source).not.toContain('saveLongContextModel');
    expect(source).not.toContain('longContextPending');
  });
});
