import type { Plugin } from 'vite';

/** Reject malformed pathname escapes before Vite's static middleware decodes them. */
export function malformedPathGuard(): Plugin {
  return {
    name: 'tower-malformed-path-guard',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        try {
          // Validate only the pathname: query values may legitimately contain '%'.
          decodeURI(new URL(req.url || '/', 'http://vite.local').pathname);
        } catch {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('잘못된 URL 인코딩입니다. / Invalid URL encoding.');
          return;
        }
        next();
      });
    },
  };
}
