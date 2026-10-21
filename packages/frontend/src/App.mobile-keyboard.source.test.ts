import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(__dirname, 'App.tsx'), 'utf8');

describe('App mobile keyboard viewport shell', () => {
  it('uses one React-owned mobile keyboard viewport at the app shell', () => {
    expect(source).toContain("import { useMobileKeyboardViewport } from './hooks/useMobileKeyboardViewport'");
    expect(source).toContain('const mobileKeyboardViewport = useMobileKeyboardViewport(isMobileQuery)');
    expect(source).toContain("style={{ height: isMobileQuery ? mobileKeyboardViewport.height : '100dvh' }}");
  });

  it('removes mobile navigation from layout without a competing height transition while the keyboard is open', () => {
    expect(source).toContain('{isMobile && !mobileKeyboardViewport.hideNavigation ? <MobileTabBar onNavigateSessions={handleNavigateSessions} /> : null}');
  });
});
