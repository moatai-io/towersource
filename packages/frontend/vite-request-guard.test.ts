import { describe, expect, it } from 'vitest';
import { malformedPathGuard } from '../../scripts/vite-request-guard';

function request(url: string) {
  let handler: any;
  const plugin = malformedPathGuard();
  (plugin.configureServer as Function)({ middlewares: { use(fn: unknown) { handler = fn; } } });
  const result = { statusCode: 200, passed: false, body: '', setHeader() {}, end(body: string) { this.body = body; } };
  handler({ url }, result, () => { result.passed = true; });
  return result;
}

describe('Vite malformed pathname guard', () => {
  it.each(['/bad%path.png', '/%', '/%E0%A4%A.png', '/%FF.png', '/%PUBLIC_URL%/favicon.ico'])('returns 400 instead of a Vite error overlay for %s', url => {
    const result = request(url);
    expect(result.statusCode).toBe(400);
    expect(result.passed).toBe(false);
    expect(result.body).toContain('Invalid URL encoding');
  });
  it.each(['/', '/src/main.tsx', '/파일.png', '/%ED%95%9C%EA%B8%80.png', '/100%25.png', '/file?q=100%', '/api/search?q=%FF'])('preserves valid paths and query strings: %s', url => {
    expect(request(url).passed).toBe(true);
  });
});
