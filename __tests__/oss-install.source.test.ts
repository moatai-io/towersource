import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (name: string) => fs.readFileSync(path.join(process.cwd(), 'scripts/oss', name), 'utf8');

describe('Tower OSS single-host installer contract', () => {
  const installer = read('install.sh');
  const doctor = read('doctor.sh');
  const bootstrap = read('bootstrap-local-worker.sh');

  it('provisions one complete server path without partial profiles', () => {
    expect(installer).toContain('setup_22.x');
    expect(installer).toContain('--profile was removed');
    expect(installer).not.toContain('PROFILE="minimal"');
    expect(installer).toContain('postgresql-18-pgvector');
    expect(installer).toContain('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    expect(installer).toContain('CREATE EXTENSION IF NOT EXISTS vector');
    expect(installer).toContain('/etc/systemd/system/tower.service');
    expect(installer).toContain('/etc/nginx/sites-available/');
    expect(installer).toContain('certbot --nginx');
    expect(installer).toContain('scripts/oss/doctor.sh');
    expect(installer).toContain("nix --extra-experimental-features 'nix-command flakes' build");
    expect(installer).toContain('/nix/var/nix/profiles/default/bin/nix');
    expect(installer).toContain('runtime-compute-doctor');
    expect(installer).toContain('tower-oss-worker-bootstrap.timer');
    expect(installer).toContain('tower-oss-worker-bootstrap.path');
    expect(installer).toContain('PathChanged=$DATA_DIR/workers/bootstrap.request');
    expect(installer).toContain('TOWER_ROLE=standalone');
    expect(installer).toContain('TOWER_AGENT_FIRST_ENABLED=true');
    expect(installer).toContain('location = /index.html');
    expect(installer).toContain('location = /sw.js');
    expect(installer).toContain('Cache-Control "no-store, no-cache, must-revalidate"');
  });

  it('keeps generated secrets local and URL-encodes the database password', () => {
    expect(installer).toContain('chmod 600 "$PG_PASSWORD_FILE"');
    expect(installer).toContain('chmod 600 "$ENV_FILE"');
    expect(installer).toContain('urllib.parse.quote');
    expect(installer).not.toContain('echo "$PG_PASSWORD"');
  });

  it('links runtime packages and verifies compute, Worker, skills, and first-login readiness', () => {
    expect(installer).toContain('dist/runtime-packages/@tower/shared');
    expect(installer).toContain('skills/managed/');
    expect(installer).toContain('bootstrap-local-worker.sh');
    expect(bootstrap).toContain('activate-oss-local-worker.js');
    expect(doctor).toContain('Runtime shared package linked');
    expect(doctor).toContain('Tower Nix closure linked');
    expect(doctor).toContain('Compute baseline ready');
    expect(doctor).toContain('Local Worker service active');
    expect(doctor).toContain('General skills materialized');
    expect(doctor).toContain('/api/health');
    expect(doctor).toContain('/api/auth/status');
  });

  it('ships the Worker bootstrap and keeps provider-specific skills out of the default seed', () => {
    const defaultSkillsBlock = installer.match(/DEFAULT_SKILLS=\(([^)]*)\)/s)?.[1] ?? '';
    for (const skill of ['gws', 'issue', 'naver-search', 'tiro', 'youtube-transcript', 'image-slide-gen']) {
      expect(defaultSkillsBlock).not.toMatch(new RegExp(`\\b${skill}\\b`));
    }
  });
});
