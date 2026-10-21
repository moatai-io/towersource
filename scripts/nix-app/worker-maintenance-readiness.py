#!/usr/bin/env python3
"""Read-only local/Fleet maintenance enrollment audit. Never emits credentials.
A timer file or matching build alone is not evidence of live admission fencing.
"""
import argparse
import json
import re
import subprocess
from pathlib import Path

ROOT = Path('/var/lib/tower-worker-maintenance')


def command(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.DEVNULL, timeout=5).strip()


def unit_state(action, unit):
    # systemctl intentionally returns non-zero for disabled, inactive, and
    # not-found units. Those are valid read-only states, not probe failures.
    result = subprocess.run(['systemctl', action, unit], text=True,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5)
    return result.stdout.strip()


def protected(path):
    for p in [path, *path.parents]:
        st = p.lstat()
        if p.is_symlink() or st.st_uid != 0 or st.st_mode & 0o022:
            raise ValueError('untrusted input')
    return path


def inspect(worker):
    row = {'workerId': worker, 'status': 'blocked', 'reason': 'inspection-unavailable'}
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,120}', worker): return row
    directory = ROOT / worker
    config_path = directory / 'config.json'
    try:
        if not config_path.exists():
            row.update(status='not-enrolled', reason='trusted-database-environment-required',
                nextAction='Provide TOWER_WORKER_MAINTENANCE_DATABASE_ENV_FILE to the approved system Worker installer; root-owned 0600 existing DB environment required. Do not copy secrets or relax permissions.')
            return row
        config = json.loads(protected(config_path).read_text())
        if config.get('workerId') != worker or config.get('version') != 1: raise ValueError('config mismatch')
        if config.get('deploymentId') == 'development':
            row.update(status='excluded', reason='development'); return row
        db = protected(Path(config['databaseEnvFile']))
        if db.stat().st_mode & 0o077: raise ValueError('DB permissions')
        # Inspect metadata only. Never read the DB environment file's contents.
        state_path = protected(directory / 'state.json')
        state = json.loads(state_path.read_text())
        if state.get('version') != 1 or 'owner' not in state: raise ValueError('state missing')
        execution_user = config.get('executionUser')
        if not isinstance(execution_user, str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_-]{0,99}', execution_user):
            row['reason'] = 'worker-execution-user-invalid'; return row
        # Root being able to read state is insufficient: the admission gate runs as
        # the Worker uid and intentionally fails closed when any parent is not traversable.
        for permission, target in [('x', ROOT), ('x', directory), ('r', state_path)]:
            probe = subprocess.run(['runuser', '-u', execution_user, '--', 'test', f'-{permission}', str(target)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
            if probe.returncode != 0:
                row.update(reason='worker-maintenance-state-unreadable',
                    nextAction='Re-run the approved Worker maintenance installer to grant only the configured Worker traverse/read access; do not chmod the state path public.')
                return row
        if state['owner'] is not None:
            row.update(reason='recovery-required', phase=state.get('phase')); return row
        timer = f'tower-worker-maintenance-{worker}.timer'
        # Scheduled mutation is forbidden; an old active/enabled timer is drift.
        if unit_state('is-enabled', timer) == 'enabled' or unit_state('is-active', timer) == 'active':
            row['reason'] = 'scheduled-maintenance-not-disabled'; return row
        service = f'tower-worker-maintenance-{worker}.service'
        if command('systemctl', 'show', service, '-p', 'LoadState', '--value') != 'loaded':
            row['reason'] = 'deployment-maintenance-service-missing'; return row
        props = dict(x.split('=', 1) for x in command('systemctl', 'show', config['unit'], '-p', 'MainPID', '-p', 'ActiveState', '-p', 'KillMode', '-p', 'SendSIGKILL').splitlines() if '=' in x)
        pid = int(props.get('MainPID', '0'))
        if pid < 1 or props.get('ActiveState') != 'active':
            row['reason'] = 'worker-not-running'; return row
        if props.get('KillMode') != 'process' or props.get('SendSIGKILL') != 'no':
            row.update(reason='first-safe-activation-required', nextAction='Approve idle Worker activation of the installed maintenance stop policy and admission gate; do not force restart busy work.'); return row
        # Read process environment only inside this audit, retain only the nonsecret
        # fence path. Never expose arbitrary Environment/EnvironmentFile values.
        entries = Path(f'/proc/{pid}/environ').read_bytes().split(b'\0')
        wanted = b'TOWER_WORKER_MAINTENANCE_STATE=' + str(directory / 'state.json').encode()
        if wanted not in entries:
            row.update(reason='first-safe-activation-required', nextAction='Approve idle activation of the new Worker gate; installed timer alone is insufficient.'); return row
        argv = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
        stores = []
        for arg in argv:
            match = re.fullmatch(rb'(/nix/store/[^/]+)/lib/tower/dist/backend/packages/backend/services/runtime-box/remote-workbench-worker-entrypoint.js', arg)
            if match: stores.append(match.group(1).decode())
        if len(stores) != 1 or json.loads(Path(stores[0], 'share/tower/worker-maintenance-protocol.json').read_text()).get('version') != 1:
            row['reason'] = 'running-protocol-unsupported'; return row
        if command('systemctl', 'show', config['unit'], '-p', 'MainPID', '--value') != str(pid):
            row['reason'] = 'process-changed'; return row
        row.update(status='ready', reason=None, approvedRev=config.get('approvedRev'), liveStore=stores[0])
    except Exception:
        # Keep a specific failure set before an unavailable probe, never emit exception text.
        pass
    return row


def audit(worker=None):
    try:
        if worker: workers = [worker]
        else:
            raw = command('systemctl', 'list-unit-files', '--type=service', '--no-legend', '--no-pager', 'tower-workbench-worker-*.service')
            workers = sorted({match.group(1) for word in raw.split() if (match := re.fullmatch(r'tower-workbench-worker-([A-Za-z0-9_.-]+)\.service', word)) and not match.group(1).endswith('-heartbeat')})
        rows = [inspect(w) for w in workers]
        ready = bool(rows) and all(r['status'] in ('ready', 'excluded') for r in rows)
        return {'status': 'ready' if ready else 'warning', 'scope': 'local-systemd-workers-only', 'workers': rows,
            'reason': None if rows else 'inventory-empty', 'restartPerformed': False}
    except Exception:
        return {'status': 'warning', 'workers': [], 'reason': 'inventory-unavailable', 'restartPerformed': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--worker')
    parser.add_argument('--require-ready', action='store_true')
    args = parser.parse_args()
    result = audit(args.worker)
    print(json.dumps(result))
    if args.require_ready and result['status'] != 'ready': raise SystemExit(1)
