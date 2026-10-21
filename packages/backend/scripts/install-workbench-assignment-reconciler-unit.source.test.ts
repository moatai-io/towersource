import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../../scripts/nix-app/install-workbench-assignment-reconciler-unit', import.meta.url), 'utf8');

describe('assignment reconciler unit installer', () => {
  it('installs root-owned system units for system-managed shared Workers', () => {
    expect(source).toContain('unit_dir=/etc/systemd/system');
    expect(source).toContain("systemctl_prefix=(systemctl)");
    expect(source).toContain("system service manager requires root");
  });

  it('keeps compatibility user units for user-managed Workers', () => {
    expect(source).toContain('$HOME/.config/systemd/user');
    expect(source).toContain('systemctl --user');
  });

  it('keeps automatic Project backfill disabled unless explicitly enabled', () => {
    expect(source).toContain('auto_backfill="${TOWER_ASSIGNMENT_AUTO_BACKFILL:-false}"');
    expect(source).toContain('Environment=TOWER_ASSIGNMENT_AUTO_BACKFILL=$auto_backfill');
  });

  it('grants write access only to Worker config, unit, and Project roots', () => {
    expect(source).toContain('ReadWritePaths=$config_parent $unit_dir $workspace_root/projects');
  });
});
