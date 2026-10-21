import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fitVisualImage } from './fit-visual-image.js';

describe('provider image fitting', () => {
  it('compresses a real multi-MB image under budget without changing source history', async () => {
    const data = execFileSync(process.env.TOWER_DOCUMENT_PYTHON || 'python3', ['-c', "from PIL import Image; import random,io,base64; r=random.Random(7); im=Image.frombytes('RGB',(1200,900),r.randbytes(1200*900*3)); b=io.BytesIO(); im.save(b,'PNG'); print(base64.b64encode(b.getvalue()).decode())"], { maxBuffer: 8 * 1024 * 1024 }).toString().trim();
    expect(Buffer.from(data, 'base64').length).toBeGreaterThan(2 * 1024 * 1024);
    const part = { type: 'image', mimeType: 'image/png', data };
    const messages = [{ role: 'toolResult', toolCallId: 'screenshot', content: [part] }];
    const fitted = await fitVisualImage(part, 512 * 1024);
    const result = [{ content: [fitted!] }];
    expect(result[0].content[0].type).toBe('image');
    expect(Buffer.from(result[0].content[0].data, 'base64').length).toBeLessThanOrEqual(512 * 1024);
    expect(messages[0].content[0]).toBe(part);
    expect(part.data).toBe(data);
  });
  it('fails closed for invalid images and exhausted budgets', async () => {
    const part = { type: 'image', data: 'AAAA', mimeType: 'image/png' };
    expect(await fitVisualImage(part, 1024)).toBeNull();
    expect(await fitVisualImage(part, 0)).toBeNull();
  });
});
