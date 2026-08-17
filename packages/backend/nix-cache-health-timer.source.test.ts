import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (name: string) => fs.readFileSync(path.join(process.cwd(), 'scripts/nix-supply-chain', name), 'utf8');
const runner = read('run-operator-cache-health');
const installer = read('install-operator-cache-health-timer');
const notifier = read('notify-operator-cache-health-email');

describe('Nix cache health timer contracts', () => {
  it('persists atomic success and failure evidence without swallowing exit status', () => {
    expect(runner).toContain('mktemp "$state_dir/last-result.json.tmp.');
    expect(runner).toContain('mv "$tmp" "$state_dir/last-result.json"');
    expect(runner).toContain('last-failure.json');
    expect(runner).toContain('rm -f "$state_dir/last-failure.json"');
    expect(runner).toContain('exit "$rc"');
  });

  it('installs a persistent randomized systemd timer with a 26-hour freshness default', () => {
    expect(installer).toContain('max_age=93600');
    expect(installer).toContain('OnCalendar=$calendar');
    expect(installer).toContain('Persistent=true');
    expect(installer).toContain('RandomizedDelaySec=5m');
    expect(installer).toContain('systemd-analyze verify');
    expect(installer).toContain('systemctl enable --now tower-nix-cache-health.timer');
  });

  it('routes service failure to a hardened Azure Action Group email notifier', () => {
    expect(installer).toContain('OnFailure=tower-nix-cache-health-email@%n.service');
    expect(installer).toContain('TOWER_NIX_CACHE_ALERT_ACTION_GROUP=tower-nix-cache-alerts');
    expect(notifier).toContain('az monitor action-group test-notifications create');
    expect(notifier).toContain('--alert-type resourcehealth');
    expect(notifier).toContain('duplicate/cooldown skip');
    expect(notifier).not.toContain('SMTP');
  });

  it('hardens the service while allowing only its state directory to be written', () => {
    expect(installer).toContain('NoNewPrivileges=true');
    expect(installer).toContain('ProtectHome=true');
    expect(installer).toContain('ProtectSystem=strict');
    expect(installer).toContain('Environment=AZURE_CONFIG_DIR=/var/lib/tower-nix-cache-health/azure');
    expect(installer).toContain('ReadWritePaths=/var/lib/tower-nix-cache-health');
    expect(installer).not.toContain('tower-cache-1.sec');
  });
});
