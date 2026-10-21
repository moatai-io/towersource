import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  PACKAGED_RELEASE_OPTIONAL_ENV,
  PACKAGED_RELEASE_REQUIRED_ENV,
} from './services/app-runtime-contract.js';

const sourcePath = path.join(process.cwd(), 'packages/backend/artifact-shadow.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const launcher = fs.readFileSync(
  path.join(process.cwd(), 'scripts/nix-app/tower-app-start-shadow'),
  'utf8',
);

function imports(): string[] {
  return [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

describe('artifact shadow source boundary', () => {
  it('does not import production authority modules', () => {
    const imported = imports();
    for (const forbidden of [
      './config.js',
      './routes/api.js',
      './routes/ws-handler.js',
      './db/pg.js',
      './engines/index.js',
    ]) {
      expect(imported).not.toContain(forbidden);
    }
    for (const fragment of [
      'unified-scheduler',
      'serverSideResumeInterrupted',
      'initWorkspaceRepo',
      'publishing/reconciler',
    ]) {
      expect(source).not.toContain(fragment);
    }
    expect(imported.some((specifier) => specifier.includes('runtime-box'))).toBe(false);
    expect(imported.some((specifier) => specifier.includes('sandbox'))).toBe(false);
  });

  it('keeps the API surface to artifact metadata and denies everything else', () => {
    expect(source).toContain("app.get('/api/health'");
    expect(source).toContain("app.get('/api/config'");
    expect(source).toContain("app.get('/runtime-config.js'");
    expect(source).toContain("env.TOWER_DEFAULT_LANGUAGE === 'en'");
    expect(source).toContain("app.all('/api/*'");
    expect(source).toContain('res.status(405)');
    expect(source).toContain("authority: 'none'");
    expect(source).toContain("apiMode: 'artifact-readonly'");
  });

  it('does not register WebSocket handlers and explicitly rejects upgrades', () => {
    expect(source).not.toContain('setupWebSocket(');
    expect(source).toContain("server.on('upgrade'");
    expect(source).toContain('403 Forbidden');
  });

  it('injects the packaged release identity from the closure manifest', () => {
    expect(launcher).toContain('share/tower/release-manifest.json');
    expect(launcher).toContain('conflicts with release manifest');
    for (const envName of [...PACKAGED_RELEASE_REQUIRED_ENV, ...PACKAGED_RELEASE_OPTIONAL_ENV]) {
      expect(launcher).toContain(envName);
    }
  });
});
