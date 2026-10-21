import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const delivery = readFileSync(new URL('./useViewerDelivery.ts', import.meta.url), 'utf8');

describe('Viewer delivery ownership', () => {
  it('keeps App on delivery hook wiring', () => {
    expect(app).toContain('const { handleMessageFileClick } = useViewerDelivery({');
    expect(app).not.toContain("window.addEventListener('tower-present-file'");
    expect(app).not.toContain("window.addEventListener('tower-open-path'");
  });

  it('queues inactive-session deliveries and consumes them on activation', () => {
    expect(delivery).toContain('queueSessionViewerDelivery({ ...delivery, focus: false, reveal: false })');
    expect(delivery).toContain('consumeSessionViewerDelivery(activeSessionId)');
    expect(delivery).toContain('presentViewerDelivery(pending, true)');
    expect(delivery).toContain('backgroundViewer: !delivery.focus');
  });

  it('opens session attachments and routes personal virtual paths', () => {
    expect(delivery).toContain('sessionAttachmentContentUrl(sessionId, path, token)');
    expect(delivery).toContain("startsWith('image/') ? 'image' : 'text'");
    expect(delivery).toContain("path === 'personal://todos'");
    expect(delivery).toContain("path === 'personal://archive'");
    expect(delivery).toContain("path.startsWith('personal://')");
  });
});
