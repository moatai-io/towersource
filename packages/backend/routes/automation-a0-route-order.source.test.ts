import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
const backendSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('api.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function literalRouterPaths(file: string): Array<{ method: string; path: string }> {
  const body = readFileSync(new URL(file, import.meta.url), 'utf8');
  const tree = ts.createSourceFile(file, body, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const paths: Array<{ method: string; path: string }> = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(tree) === 'router'
      && ts.isStringLiteral(node.arguments[0])) {
      paths.push({ method: node.expression.name.text, path: node.arguments[0].text });
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return paths;
}
const routes: Array<{ method: string; path: string; start: number; auth: string }> = [];
for (const statement of ast.statements) {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
  const call = statement.expression;
  if (!ts.isPropertyAccessExpression(call.expression) || call.expression.expression.getText(ast) !== 'router'
    || !['get', 'post', 'put', 'patch', 'delete', 'all'].includes(call.expression.name.text)
    || !ts.isStringLiteral(call.arguments[0])) continue;
  routes.push({ method: call.expression.name.text, path: call.arguments[0].text,
    start: statement.getStart(ast), auth: call.arguments[1]?.getText(ast) || '' });
}

const guarded = ['full-dry-run', 'observe-dry-run', 'save-yaml'] as const;

describe('Automation A0 route registration in the composition root', () => {
  it.each(guarded)('%s is registered once with auth, after global auth and before the generic id route', slug => {
    const route = `/automations/:id/${slug}`;
    const matches = routes.filter(item => item.method === 'post' && item.path === route);
    expect(matches).toHaveLength(1);
    expect(matches[0].auth).toBe('authMiddleware');
    expect(matches[0].start).toBeGreaterThan(source.indexOf('router.use(authMiddleware)'));
    const generic = routes.find(item => item.method === 'post' && item.path === '/automations/:id');
    if (generic) expect(matches[0].start).toBeLessThan(generic.start);
  });

  it('does not put a catch-all automation POST route ahead of A0 endpoints', () => {
    const first = Math.min(...routes.filter(item => item.method === 'post' && guarded.some(slug => item.path === `/automations/:id/${slug}`)).map(item => item.start));
    expect(routes.filter(item => item.start < first && ['post', 'all'].includes(item.method)
      && ['/automations/*', '/automations/:id/*', '/automations/:id/:action', '/automations/:id/:rest(*)'].includes(item.path))).toEqual([]);
  });

  it('keeps the broad /api voice mount route-specific and places the production API router after it', () => {
    expect(backendSource.indexOf("app.use('/api', voiceApiRouter)")).toBeGreaterThan(0);
    expect(backendSource.indexOf("app.use('/api', apiRouter)")).toBeGreaterThan(backendSource.indexOf("app.use('/api', voiceApiRouter)"));
    const voice = literalRouterPaths('../services/voice-runtime/voice-router.ts');
    expect(voice).toEqual(expect.arrayContaining([
      { method: 'use', path: '/sessions/:sessionId/voice' },
      { method: 'use', path: '/voice/internal' },
    ]));
    expect(voice.every(({ path }) => path === '/voice/internal' || path.startsWith('/voice/') || path.startsWith('/sessions/:sessionId/voice'))).toBe(true);
  });

  it('keeps all earlier root-mounted protected routers disjoint from automation paths', () => {
    const first = Math.min(...routes.filter(item => item.method === 'post' && guarded.some(slug => item.path === `/automations/:id/${slug}`)).map(item => item.start));
    const earlyRootMounts = [...source.matchAll(/router\.use\('\/',\s*(\w+)\)/g)]
      .filter(match => (match.index ?? Infinity) < first).map(match => match[1]);
    expect(earlyRootMounts).toEqual(['publicProjectMcpOAuthRouter', 'projectMcpRouter', 'sessionMcpSelectionRouter', 'projectFilesRouter', 'sessionCoreRouter']);
    for (const file of [
      './project-mcp-api.ts', './session-core/session-mcp-selection-router.ts',
      './project-files/project-files-router.ts', './session-core/session-core-router.ts',
      './session-core/administrator-participation-router.ts', './session-core/session-trash-router.ts',
    ]) {
      const paths = literalRouterPaths(file);
      expect(paths.length, `${file} route inventory`).toBeGreaterThan(0);
      expect(paths.filter(({ path }) => path === '/' || path.startsWith('/automations') || path.startsWith('/*')), `${file} may shadow automation`).toEqual([]);
    }
  });
});
