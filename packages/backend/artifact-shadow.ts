import compression from 'compression';
import express, { type Express } from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveArtifactShadowConfig, type ArtifactShadowConfig } from './services/app-shadow-contract.js';
import { getVersionInfo } from './utils/pkg-info.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..', '..', '..', '..');

export interface ArtifactShadowApp {
  app: Express;
  config: ArtifactShadowConfig;
  frontendPath: string;
}

/**
 * Create the Phase 5B artifact-only surface.
 *
 * Deliberately do not import production config.ts, routes/api.ts, DB, WebSocket,
 * schedulers, recovery, workspace/git, publishing, sandbox, Runtime Box, engines
 * or credential modules. The only dynamic surface is release metadata already
 * proven by the package probe; every /api route outside the two allowlisted GETs
 * is denied before the static SPA fallback.
 */
export function createArtifactShadowApp(env: NodeJS.ProcessEnv = process.env): ArtifactShadowApp {
  const config = resolveArtifactShadowConfig(env);
  const frontendPath = path.join(packageRoot, 'dist', 'frontend');
  if (!fs.existsSync(path.join(frontendPath, 'index.html'))) {
    throw new Error(`Artifact shadow frontend is missing: ${frontendPath}`);
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(compression({ threshold: 512 }));
  app.use((_req, res, next) => {
    res.setHeader('X-Tower-Run-Mode', 'shadow');
    res.setHeader('X-Tower-Shadow-Profile', 'artifact');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      ...getVersionInfo(),
      runMode: config.runMode,
      shadowProfile: config.profile,
      authority: 'none',
    });
  });

  app.get('/api/config', (_req, res) => {
    const version = getVersionInfo();
    res.json({
      version: version.version,
      baseVersion: version.baseVersion,
      commitsSinceTag: version.commitsSinceTag,
      gitSha: version.gitSha,
      buildTime: version.buildTime,
      sourceRev: version.sourceRev,
      flakeLockNarHash: version.flakeLockNarHash,
      releaseMetadataSource: version.metadataSource,
      runMode: config.runMode,
      shadowProfile: config.profile,
      authority: 'none',
      apiMode: 'artifact-readonly',
      publicUrl: null,
      sharePublicUrl: null,
      authEnabled: false,
      models: [],
    });
  });

  app.all('/api/*', (req, res) => {
    res.status(405).json({
      error: 'Artifact shadow exposes only GET /api/health and GET /api/config',
      method: req.method,
      runMode: config.runMode,
      shadowProfile: config.profile,
    });
  });

  app.get('/sw.js', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(frontendPath, 'sw.js'));
  });
  app.use(express.static(frontendPath, {
    setHeaders: (res, filePath) => {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));
  app.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(frontendPath, 'index.html'));
  });

  return { app, config, frontendPath };
}

export function startArtifactShadow(env: NodeJS.ProcessEnv = process.env): http.Server {
  const { app, config } = createArtifactShadowApp(env);
  const server = http.createServer(app);
  server.on('upgrade', (_request, socket) => {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
  });
  server.listen(config.port, config.host, () => {
    console.log(`[artifact-shadow] loopback=${config.host}:${config.port} authority=none profile=${config.profile}`);
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startArtifactShadow();
}
