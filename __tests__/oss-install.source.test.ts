import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (name: string) => fs.readFileSync(path.join(process.cwd(), 'scripts/oss', name), 'utf8');

describe('Tower OSS single-host installer contract', () => {
  const bootstrap = read('bootstrap.sh');
  const installer = read('install.sh');
  const doctor = read('doctor.sh');
  const workerBootstrap = read('bootstrap-local-worker.sh');

  it('bootstraps a blank supported Ubuntu host from the public repository', () => {
    expect(bootstrap).toContain('https://github.com/moatai-io/towersource.git');
    expect(bootstrap).toContain("apt-get install -y -qq ca-certificates curl git");
    expect(bootstrap).toContain('git clone --filter=blob:none');
    expect(bootstrap).toContain('scripts/oss/install.sh');
  });

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
    expect(installer).toContain('share/tower/release-manifest.json');
    expect(installer).toContain('--source-rev <sha>');
    expect(installer).toContain('git -C "$SOURCE_DIR" rev-parse HEAD');
    expect(installer).toContain('"$SOURCE_DIR/.source-rev"');
    expect(installer).toContain('Exact source revision unavailable');
    expect(installer).toContain('RELEASE_ENV_FILE="$DATA_DIR/release.env"');
    expect(installer).toContain('source_rev[:12]');
    expect(installer).toContain("'TOWER_PACKAGED_RELEASE=true'");
    expect(installer).toContain('EnvironmentFile=$RELEASE_ENV_FILE');
    expect(installer).toContain('systemctl restart tower');
    expect(installer).toContain('if [[ -s "$DATA_DIR/workers/tower-oss-local-01/activated" ]]');
    expect(installer).toContain('systemctl disable --now tower-oss-worker-bootstrap.timer');
    expect(installer).not.toContain('systemctl enable --now tower tower-oss-worker-bootstrap.timer tower-oss-worker-bootstrap.path');
    expect(doctor).toContain('Release identity matches Nix manifest');
    expect(doctor).toContain("health.get('metadataSource') == 'injected'");
    expect(installer).toContain('tower-oss-worker-bootstrap.timer');
    expect(installer).toContain('tower-oss-worker-bootstrap.path');
    expect(installer).toContain('PathChanged=$DATA_DIR/workers/bootstrap.request');
    expect(installer).toContain('TOWER_ROLE=standalone');
    expect(installer).toContain('TOWER_AGENT_FIRST_ENABLED=true');
    expect(installer).toContain('location = /index.html');
    expect(installer).toContain('location = /sw.js');
    expect(installer).toContain('Cache-Control "no-store, no-cache, must-revalidate"');
    expect(installer).toContain('apply-db-migrations.js" apply');
    expect(installer).toContain("apply-db-migrations.js\" status | grep -E '^\\{\"status\":\"ok\"' | tail -n 1");
    expect(installer).toContain('pendingCount');
    const envHeredoc = installer.slice(installer.indexOf('cat > "$ENV_FILE" <<EOF'), installer.indexOf('\nEOF', installer.indexOf('cat > "$ENV_FILE" <<EOF')));
    expect(envHeredoc).not.toContain('`');
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
    expect(workerBootstrap).toContain('activate-oss-local-worker.js');
    expect(doctor).toContain('Runtime shared package linked');
    expect(doctor).toContain('Tower Nix closure linked');
    expect(doctor).toContain('Compute baseline ready');
    expect(doctor).toContain('Local Worker service active');
    expect(doctor).toContain('General skills materialized');
    expect(doctor).toContain('/api/health');
    expect(doctor).toContain('/api/auth/status');
  });

  it('requires the committed npm lockfile instead of silently selecting new dependencies', () => {
    expect(installer).toContain('npm ci --no-audit --no-fund');
    expect(installer).not.toContain('npm install --no-audit --no-fund');
    expect(installer).not.toContain('falling back to npm install');
  });

  it('ships the Worker bootstrap and keeps provider-specific skills out of the default seed', () => {
    const defaultSkillsBlock = installer.match(/DEFAULT_SKILLS=\(([^)]*)\)/s)?.[1] ?? '';
    for (const skill of ['gws', 'issue', 'naver-search', 'tiro', 'youtube-transcript', 'image-slide-gen']) {
      expect(defaultSkillsBlock).not.toMatch(new RegExp(`\\b${skill}\\b`));
    }
  });
});
