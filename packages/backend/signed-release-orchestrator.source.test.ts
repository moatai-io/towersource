import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const release = read('scripts/release/orchestrate-signed-release');
const start = read('start.sh');

describe('immutable signed release run source contract', () => {
  it('freezes exact revision, targets, migrations and an approval hash', () => {
    expect(release).toContain("'sourceRev':rev");
    expect(release).toContain("'targets':json.loads(targets)");
    expect(release).toContain("'migrations':ms");
    expect(release).toContain("'migrationRisk':json.loads(risk)");
    expect(release).toContain("x['planHash']=hashlib.sha256");
    expect(release).toContain('approval hash does not match immutable plan');
    expect(release).toContain('merge-base --is-ancestor');
    expect(release).toContain('verify-attestation');
  });

  it('promotes only a revision with successful Operator verification and keeps prepare non-mutating', () => {
    expect(release).toContain('verification-status --source-rev "$source_rev"');
    expect(release).toContain('operator-verification.json');
    expect(release).toContain("write_state prepared 'Verified Operator artifact Fleet-promoted; services unchanged'");
    expect(release).toContain('prepare must complete before apply');
    expect(release.indexOf('"$prod_upgrade" "${args[@]}"')).toBeGreaterThan(-1);
  });

  it('materializes public key and promotion ledger into the durable run', () => {
    expect(release).toContain('materialize_public_evidence');
    expect(release).toContain('sudo install -m 0644 "$public_key_file"');
    expect(release).toContain('sudo install -m 0644 "$ledger"');
    expect(release).toContain('TOWER_FLEET_PUBLIC_KEY_FILE="$release_public_key"');
    expect(release).toContain('TOWER_FLEET_PROMOTION_LEDGER="$release_ledger"');
  });

  it('keeps an advanced Operator unchanged and delegates all approved targets to one prestage-aware Fleet run', () => {
    expect(release).toContain('Operator remains at $operator_current; prestaging approved Fleet before canary cutover');
    expect(release).not.toContain("write_state applying-operator");
    expect(release).not.toContain('"$prod_upgrade" activate --approve-rev "$source_rev"');
    expect(release).toContain('mapfile -t approved_targets');
    expect(release).toContain('targets_csv="$(IFS=,; echo "${approved_targets[*]}")"');
    expect(release).toContain('run_fleet_target "$targets_csv" "$fleet_state" "$fleet_log"');
    expect(release).toContain("write_state done 'Operator, canary and approved fleet verified'");
  });

  it('gates each fleet target on AI credential and Runtime Box readiness before mutation', () => {
    expect(release).toContain('check-ai-capabilities.sh');
    expect(release).toContain('for customer in "${approved_targets[@]}"');
    expect(release).toContain('check_readiness "$customer"');
    expect(release).toContain('readiness-$customer.txt');
  });

  it('passes exact migration approval only when the immutable plan has migrations', () => {
    expect(release).toContain('migration_count="$(python3 -c');
    expect(release).toContain('((migration_count == 0)) || fleet_args+=(--approve-db-migrations "$source_rev")');
    expect(release).toContain('"$fleet_upgrade" "${fleet_args[@]}"');
    expect(release).not.toMatch(/\$fleet_upgrade[^\n]*--ack-db-migrations-separate/);
  });

  it('freezes migration changes from each customer current revision to the Fleet target', () => {
    expect(release).toContain("[remote,'status',row['name']]");
    expect(release).toContain("f'{current}..{target}'");
    expect(release).not.toContain('$running..$source_rev');
  });

  it('classifies destructive migrations into a separate manual workflow', () => {
    expect(release).toContain("r'\\bDROP\\s+(TABLE|COLUMN|TYPE|INDEX)\\b'");
    expect(release).toContain("'classification':'manual-required' if destructive else 'reviewed-idempotent'");
    expect(release).toContain('destructive migration requires a separate manual workflow');
  });

  it('delegates backup and frozen TARGET migration execution to the Fleet runner', () => {
    expect(release).toContain('The Fleet runner owns');
    expect(release).toContain('run_fleet_target');
    expect(release).not.toContain('apply_migrations');
    expect(release).not.toContain('psql "$DATABASE_URL"');
    expect(release).not.toContain('INSERT INTO _migrations');
  });

  it('emits only immutable-plan target names into the Fleet target CSV', () => {
    expect(release).toContain("for target in json.load(open(sys.argv[1]))['targets']: print(target['name'])");
    expect(release).toContain('targets_csv="$(IFS=,; echo "${approved_targets[*]}")"');
    expect(release).not.toContain('rest[@]');
  });

  it('is explicit-target and fail-closed', () => {
    expect(release).toContain('non-deployable target');
    expect(release).toContain("write_state failed 'approved fleet prestage or canary/follower rollout failed'");
    expect(release).not.toContain('--all');
    expect(release).not.toContain('git stash');
    expect(release).not.toContain('--no-verify');
  });

  it('exposes plan, prepare, apply, resume and status from start.sh', () => {
    for (const command of ['release-plan)', 'release-prepare)', 'release-apply)', 'release-resume)', 'release-status)']) {
      expect(start).toContain(command);
    }
  });
});
