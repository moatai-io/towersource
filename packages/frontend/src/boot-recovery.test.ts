import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const watchdog = html.slice(html.indexOf('// Boot watchdog:'), html.indexOf('// Escape hatch:'));
function boot(mounted = false, previous = '', blocked = false) {
  const message = { textContent: '' };
  const retry = { hidden: true };
  let timeout: () => void = () => {};
  let writes = 0;
  const context = {
    location: { search: '', hostname: 'tower.example.com' },
    document: {
      documentElement: { hasAttribute: () => mounted },
      getElementById: (id: string) => id === 'tower-boot-message' ? message : retry,
    },
    sessionStorage: {
      getItem: () => { if (blocked) throw Error('blocked'); return previous; },
      setItem: () => { writes++; if (blocked) throw Error('blocked'); },
    },
    window: { addEventListener: () => {} },
    setTimeout: (fn: () => void) => { timeout = fn; },
    Promise: { resolve: () => ({ catch: () => ({ then: () => {} }) }) },
    Date,
  };
  vm.runInNewContext(watchdog, context);
  timeout();
  return { message, retry, writes };
}

describe('standalone boot recovery', () => {
  it('keeps a self-styled shell outside React with same-context recovery', () => {
    expect(html).toContain('id="tower-boot-status"');
    expect(html).toContain('href="/api/client-reset"');
    expect(html).toContain('encodeURIComponent(location.pathname + location.search + location.hash)');
    const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
    expect(main).toContain("document.getElementById('tower-boot-status')?.remove()");
    expect(main).toMatch(/useEffect\(\(\) => \{\s*document.documentElement.setAttribute\('data-app-mounted'/);
    expect(main).toMatch(/<React.Suspense[^>]*>\s*<AppReady>/);
  });
  it('does not touch a successfully mounted screen', () => {
    expect(boot(true).retry.hidden).toBe(true);
  });
  it('shows manual recovery after an earlier automatic attempt without looping', () => {
    const result = boot(false, '1');
    expect(result.retry.hidden).toBe(false);
    expect(result.writes).toBe(0);
  });
  it('still offers recovery when session storage is blocked', () => {
    expect(boot(false, '', true).retry.hidden).toBe(false);
  });
});
