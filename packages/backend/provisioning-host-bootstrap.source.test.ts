import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {generateKeyPairSync,createHash} from 'node:crypto';
import path from 'node:path';
const script=path.resolve('scripts/nix-app/prepare-provisioning-host'),source=readFileSync(script,'utf8');
const python=source.split("<<'PY'\n")[1]?.replace(/\nPY\n?$/,'');
const key=generateKeyPairSync('ed25519').publicKey.export({format:'pem',type:'spki'}).toString();
const config={version:1,instanceId:'11111111-1111-1111-1111-111111111111',subject:'fixture_operator',sourceRev:'a'.repeat(40),publicUrl:'https://tower.example.invalid',cacheUrl:'https://cache.example.invalid',signingPublicKey:`fixture:${Buffer.alloc(32).toString('base64')}`,approvalPublicKey:key,port:32365};
function fixture(body:string){
 // Load definitions only. Never main/apply: no apt, PostgreSQL, systemd or /etc writes.
 const input=`import json, tempfile, pathlib, os, ast\nns={'__name__':'source_fixture'}\ncode=${JSON.stringify(python)}\nast.parse(code)\nexec(compile(code,'bootstrap-fixture','exec'),ns)\nconfig=json.loads(${JSON.stringify(JSON.stringify(config))})\n${body}`;
 return execFileSync('python3',['-c',input],{encoding:'utf8',timeout:10000});
}
describe('fresh provisioning host bootstrap source contract',()=>{
 it('shell and embedded Python parse without executing host preparation',()=>{
  execFileSync('bash',['-n',script],{timeout:5000});expect(python).toBeTruthy();expect(fixture('print("parsed")')).toBe('parsed\n');
 });
 it('validates generic public config and rejects malformed JSON field types',()=>{
  const result=fixture(`validate=ns['validate_config']\nassert validate(config)==config\nfor value in [None,[],{},dict(config,version=True),dict(config,port=True),dict(config,instanceId=7),dict(config,subject=[]),dict(config,sourceRev=None),dict(config,publicUrl=3),dict(config,cacheUrl=[]),dict(config,signingPublicKey=4),dict(config,approvalPublicKey=None),dict(config,extra='unexpected')]:\n try: validate(value)\n except ns['Rejected']: pass\n else: raise AssertionError('invalid_config_accepted')\nprint('validated')`);
  expect(result).toBe('validated\n');
 });
 it('rejects unsafe public URLs, wrong keys, non-full revision and port bounds',()=>{
  expect(fixture(`validate=ns['validate_config']\nchanges=[('publicUrl','http://tower.example.invalid'),('publicUrl','https://user@tower.example.invalid'),('publicUrl','https://tower.example.invalid/path'),('publicUrl','https://tower.example.invalid?query'),('publicUrl','https://tower.example.invalid#fragment'),('publicUrl','https://tower.example.invalid:444'),('publicUrl','https://../'),('publicUrl','https://tower.example.invalid\\nPORT=1'),('cacheUrl','https://user:password@cache.example.invalid'),('approvalPublicKey','private-key-text'),('sourceRev','a'*39),('signingPublicKey','bad'),('port',5432),('port',1023),('port',65536)]\nfor name,value in changes:\n try: validate(dict(config,**{name:value}))\n except ns['Rejected']: pass\n else: raise AssertionError('unsafe_config_accepted')\nprint('rejected')`)).toBe('rejected\n');
 });
 it('actual preflight/ACK gating fixture performs no mutation or subprocess',()=>{
  expect(fixture(`import sys, io, contextlib\nreads=[]\nns['trusted_config']=lambda p,h: config\nns['host_contract']=lambda: reads.append('host')\nns['fresh_only']=lambda p: reads.append('fresh')\nns['os'].geteuid=lambda:0\nns['run']=lambda *a,**k: (_ for _ in ()).throw(AssertionError('unexpected_subprocess'))\nns['apply']=lambda *a: (_ for _ in ()).throw(AssertionError('unexpected_apply'))\nsys.argv=['fixture','--config','/trusted/config.json','--plan-hash','a'*64,'--mode','preflight']\nwith contextlib.redirect_stdout(io.StringIO()) as output:\n assert ns['main']()==0\nplan=json.loads(output.getvalue())\nassert plan['applyAuthorized'] is False and plan['towerStarted'] is False\nassert reads==['host','fresh']\nprint('preflight')`)).toBe('preflight\n');
  expect(fixture(`try: ns['apply'](config,'a'*64)\nexcept ns['Rejected'] as e: assert str(e)=='bootstrap_ack_required'\nelse: raise AssertionError('apply_without_ack')\nprint('ack')`)).toBe('ack\n');
 });
 it('hashes exact raw config bytes and rejects duplicate-key JSON',()=>{
  expect(source).toContain('hashlib.sha256(raw).hexdigest()!=expected');expect(source).toContain('object_pairs_hook=unique');
  const compact=JSON.stringify(config),pretty=JSON.stringify(config,null,2);expect(createHash('sha256').update(compact).digest('hex')).not.toBe(createHash('sha256').update(pretty).digest('hex'));
  expect(source).toContain('st.st_nlink!=1');expect(source).toContain('os.O_NOFOLLOW');
 });
 it('preflight is read-only, fresh-only and tied to explicit Ubuntu24 root contract',()=>{
  expect(source).toContain("os.geteuid()!=0");expect(source).toContain("!='24.04'");expect(source).toContain("os.uname().machine!='x86_64'");
  const main=source.slice(source.indexOf('def main():'));expect(main).toContain("host_contract(); fresh_only(c['port'])");expect(main).toContain("if args.mode=='preflight':");expect(main).toContain('else: apply(c,args.plan_hash)');
  expect(source).toContain("os.environ.get('TOWER_PROVISIONING_BOOTSTRAP_ACK')!=plan_hash");
  expect(source).toContain("pathlib.Path('/etc/tower')");expect(source).toContain('bootstrap_existing_state_reconciliation_required');expect(source).toContain('bootstrap_existing_user');expect(source).toContain('bootstrap_existing_database');
 });
 it('persists intent before packages and never restarts or deploys Tower/Fleet',()=>{
  const apply=source.slice(source.indexOf('def apply('),source.indexOf('def main('));
  expect(apply.indexOf("document(JOURNAL/'bootstrap-intent.json'")).toBeLessThan(apply.indexOf("run(['/usr/bin/apt-get','update']"));
  expect(apply).toContain("document(JOURNAL/'bootstrap-success.json'");expect(apply).not.toMatch(/unlink|rmtree|remove/);
 });
 it('uses signed distro baseline packages and no remote installer/TLS/Worker execution',()=>{
  for(const name of ['postgresql-contrib','nix-bin','nix-setup-systemd','python3-certbot-nginx','apparmor','apparmor-utils','ufw','acl','sudo'])expect(source).toContain(`'${name}'`);
  expect(source).not.toMatch(/--allow-unauthenticated|curl\s.*\|\s*(?:sh|bash)|certbot[^\n]*--nginx|git\s+clone|nix\s+build/);
  expect(source).not.toContain('bootstrap-local-worker.sh');expect(source).not.toContain('apply-db-migrations');expect(source).not.toContain('fleet/');
  expect(source).toContain("'towerStarted':False,'workerStarted':False");expect(source).toContain("'enable','--now','nix-daemon.socket'");
  expect(source).toContain("'/usr/sbin/ufw','allow','22/tcp'");expect(source).toContain("'/usr/sbin/ufw','--force','enable'");expect(source).toContain("'nginx.service'");expect(source).toContain("'certbot.timer'");expect(source).not.toContain("'/usr/sbin/ufw','allow','443/tcp'");
 });
 it('runtime policy matches native contract with generated secrets confined to stdin/env',()=>{
  expect(source).toContain("'mode':'shared-local','backendUid':backend.pw_uid,'workerUid':worker.pw_uid,'projectParents':[str(RUNTIME/'workspace/projects')]");
  expect(source).toContain("'NO_AUTH':'false','TOWER_ROLE':'standalone','TOWER_AGENT_FIRST_ENABLED':'true'");
  expect(source).toContain("'HOST':'127.0.0.1','PORT':str(c['port'])");expect(source).toContain("'environmentFile':str(ETC/'runtime.env')");
  for(const declaration of ["'TOWER_RUNTIME_CWD':str(RUNTIME)","'TOWER_RUNTIME_DATA_DIR':str(RUNTIME/'data')","'TEAMSKILLS_PROJECT_ROOT':str(RUNTIME/'workspace/projects/teamskills')"])expect(source).toContain(declaration);
  expect(source).toContain("sql.encode()");expect(source).toContain("secrets.token_hex(32)");expect(source).toContain("b'create extension \"uuid-ossp\"; create extension pg_trgm;\\n'");
  expect(source).not.toMatch(/print\([^\n]*(?:password|JWT_SECRET|env\b)|subprocess[^\n]*shell\s*=\s*True/);
  expect(source).toContain('set +x');expect(source).toContain("os.symlink(str(ETC/'runtime.env'),RUNTIME/'tower.env')");
  expect(source).toContain("'TOWER_INSTANCE_ID':c['instanceId'],'TZ':'Asia/Seoul'");expect(source).toContain("'set-timezone','Asia/Seoul'");expect(source).toContain('bootstrap_postgres_baseline_invalid');
 });
 it('atomic receipt fixture is private, fsynced and collision rejecting',()=>{
  expect(fixture(`with tempfile.TemporaryDirectory() as d:\n p=pathlib.Path(d)/'receipt.json'\n ns['document'](p,{'state':'intent'})\n assert (p.stat().st_mode&0o777)==0o600\n assert json.loads(p.read_text())=={'state':'intent'}\n assert not pathlib.Path(str(p)+'.pending').exists()\n try: ns['document'](p,{'state':'overwrite'})\n except ns['Rejected']: pass\n else: raise AssertionError('receipt_overwritten')\n assert json.loads(p.read_text())=={'state':'intent'}\nprint('atomic')`)).toBe('atomic\n');
  expect(source).toContain('os.fsync(fd)');expect(source).toContain('os.rename(temp,p); syncdir(p.parent)');
 });
});
