import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const app = [
  fs.readFileSync(path.resolve(import.meta.dirname, './App.tsx'), 'utf8'),
  fs.readFileSync(path.resolve(import.meta.dirname, './hooks/useViewerDelivery.ts'), 'utf8'),
  fs.readFileSync(path.resolve(import.meta.dirname, './hooks/useFileOpenActions.ts'), 'utf8'),
].join('\n');
const runtime = fs.readFileSync(path.resolve(import.meta.dirname, './hooks/useChatRuntime.ts'), 'utf8');
const backend = fs.readFileSync(path.resolve(import.meta.dirname, '../../backend/routes/ws-handler.ts'), 'utf8');

describe('present_file session-aware Viewer delivery', () => {
  it('opens focused active-session delivery even when the Viewer was collapsed', () => {
    expect(app).toContain('backgroundViewer: !delivery.focus');
    expect(app).toContain('const focusedViewerRequestRef = useRef(0)');
    expect(app).toContain('focusedViewerRequestId === focusedViewerRequestRef.current');
    expect(app).toContain('if (!backgroundViewer && !isLatestFocusedViewerRequest)');
    expect(app).toContain("stalePlaceholder.content === ''");
    expect(app).toContain('backgroundSplit: backgroundViewer');
    expect(app).toContain("if (existingTab) {\n          fileStore.openSplitTab(existingTab.id, 'right');");
    expect(app).toContain("fileStore.openTab(path, '', getFileExt(path) === 'html' ? 'html' : 'text'");
    expect(app).toContain("if (opened) useFileStore.getState().openSplitTab(opened.id, 'right')");
    expect(app).not.toContain('!isActiveSession || !useFileStore.getState().contextPanelOpen');
  });

  it('does not leave an optimistic empty Viewer tab after a file read failure', () => {
    expect(app).toContain("console.warn('[app] viewer file open failed:', error)");
    expect(app).toContain("toastError(error instanceof Error ? error.message : t('fileLoadFailedWithStatus'");
    expect(app).toContain("!existingTab && currentViewerTab && !currentViewerTab.modified && currentViewerTab.content === ''");
    expect(app).toContain('store.closeTab(currentViewerTab.id)');
    expect(app).not.toContain('viewer file open failed, falling back to existing tab/websocket');
  });

  it('queues inactive-session delivery and consumes it when that session becomes active', () => {
    expect(app).toContain('queueSessionViewerDelivery({ ...delivery, focus: false, reveal: false })');
    expect(app).toContain('consumeSessionViewerDelivery(activeSessionId)');
    expect(app).toContain('presentViewerDelivery(pending, true)');
  });

  it('propagates a stable tool-use delivery id from backend to frontend', () => {
    expect(backend).toContain('deliveryId: string');
    expect(backend).toContain('deliveryId,');
    expect(backend).toContain('sessionId, toolUseId, result');
    expect(runtime).toContain('deliveryId: data.deliveryId');
  });
});
