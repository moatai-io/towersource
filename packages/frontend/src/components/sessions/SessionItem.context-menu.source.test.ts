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

  it('offers a session-local long-context model toggle via modelUsed PATCH', () => {
    expect(source).toContain(`const LONG_CONTEXT_MODEL_USED = "litellm-responses/smartest-long";`);
    expect(source).toContain(`const DEFAULT_CONTEXT_MODEL_USED = "litellm-responses/smartest";`);
    expect(source).toContain("onToggleLongContext={toggleLongContext}");
    expect(source).toContain(`{longContext ? "일반 컨텍스트로 되돌리기" : "롱컨텍스트로 처리"}`);
    expect(source).toContain("body: JSON.stringify({ modelUsed: nextModel }),");
    expect(source).toContain('setLongContextPending(true);');
    expect(source).toContain('.getState()\n        .updateSessionMeta(session.id, { modelUsed: nextModel });');
    expect(source).not.toContain('const previousModel = session.modelUsed;');
  });
});
