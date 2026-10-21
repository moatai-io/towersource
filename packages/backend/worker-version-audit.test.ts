import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

describe('read-only Worker version audit', () => {
  it('classifies actual process identity, drift, missing inventory and inspection errors', () => {
    const result = execFileSync('python3', ['-c', `
import importlib.util,json
from unittest.mock import patch
s=importlib.util.spec_from_file_location('audit','scripts/nix-app/worker-version-audit.py'); m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
rev='a'*40
unit='tower-workbench-worker-example.service'
def cmd(*a):
 if a[1]=='list-units': return unit+' loaded active running example\\n'
 if '--value' in a: return '123\\n'
 return 'MainPID=123\\nActiveState=active\\n'
with patch.object(m,'command',side_effect=cmd), patch.object(m.Path,'read_bytes',return_value=b'node\\0/nix/store/example/lib/tower/dist/backend/packages/backend/services/runtime-box/remote-workbench-worker-entrypoint.js\\0'), patch.object(m.Path,'read_text',return_value=json.dumps({'sourceRev':rev})):
 assert m.audit(rev)['status']=='match'
 assert 'maintenanceReady' in m.audit(rev)
 assert 'maintenance' in m.audit(rev)['workers'][0]
 assert m.audit('b'*40)['workers'][0]['status']=='different'
 with patch.object(m.Path,'read_bytes',side_effect=PermissionError):
  assert m.audit(rev)['workers'][0]['status']=='unknown'
with patch.object(m,'command',return_value=''):
 assert m.audit(rev)['reason']=='inventory-empty'
with patch.object(m,'command',side_effect=TimeoutError):
 assert m.audit(rev)['reason']=='inventory-unavailable'
print('ok')
`], { encoding: 'utf8' });
    expect(result.trim()).toBe('ok');
  });
  it('records before/after audits including restart recovery without restarting Workers', () => {
    const source = readFileSync('scripts/nix-app/orchestrate-operator-upgrade', 'utf8');
    expect(source).toContain('workerVersionAuditAfter');
    expect(source).toContain('workerRelatedChangedPaths');
    expect(source).toContain('workerReviewRequired');
    expect(source).toContain("bool(r['workerRelatedChangedPaths'])");
    expect(source).toContain("get('maintenanceReady') is False");
    expect(source.slice(source.indexOf('reconcile_state(){'), source.indexOf('if [[ "$action" = status'))).toContain('audit_workers');
    expect(source).not.toContain('systemctl restart');
  });
});
