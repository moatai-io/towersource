import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const main = fs.readFileSync(path.resolve(import.meta.dirname, './main.tsx'), 'utf8');
const page = fs.readFileSync(path.resolve(import.meta.dirname, './components/common/InvalidLinkPage.tsx'), 'utf8');

describe('unknown Tower links', () => {
  it('renders an explicit recovery page instead of silently falling through to App', () => {
    expect(main).toContain("const APP_SHELL_PATHS = ['/', '/s/:sessionId', '/r/:roomId', '/rooms/:roomId'] as const");
    expect(main).toContain('<Route path="*" element={<InvalidLinkPage />} />');
    expect(main).not.toContain('<Route path="*" element={<App />} />');
    expect(page).toContain("t('invalidLinkTitle')");
    expect(page).toContain('href="/"');
  });
});
