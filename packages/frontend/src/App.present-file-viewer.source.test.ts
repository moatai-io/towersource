import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const app = fs.readFileSync(path.resolve(import.meta.dirname, './App.tsx'), 'utf8');
const runtime = fs.readFileSync(path.resolve(import.meta.dirname, './hooks/useChatRuntime.ts'), 'utf8');
const backend = fs.readFileSync(path.resolve(import.meta.dirname, '../../backend/routes/ws-handler.ts'), 'utf8');

describe('present_file session-aware Viewer delivery', () => {
  it('opens focused active-session delivery even when the Viewer was collapsed', () => {
    expect(app).toContain('backgroundViewer: !delivery.focus');
    expect(app).not.toContain('!isActiveSession || !useFileStore.getState().contextPanelOpen');
  });

  it('queues inactive-session delivery and consumes it when that session becomes active', () => {
    expect(app).toContain('queueSessionViewerDelivery(delivery)');
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
