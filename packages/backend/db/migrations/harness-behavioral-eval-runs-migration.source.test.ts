import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source=fs.readFileSync(path.resolve(import.meta.dirname,'./130_harness_behavioral_eval_runs.sql'),'utf8');

describe('Harness behavioral eval run migration',()=>{
  it('stores immutable run identity, report and status separately',()=>{
    expect(source).toContain('CREATE TABLE IF NOT EXISTS harness_behavioral_eval_runs');
    expect(source).toContain('prompt_bundle_hash TEXT NOT NULL');
    expect(source).toContain('eval_pack_hash TEXT NOT NULL');
    expect(source).toContain("status IN ('running','passed','failed','error')");
  });
  it('stores append-only baseline/candidate promotion decisions',()=>{
    expect(source).toContain('CREATE TABLE IF NOT EXISTS harness_eval_promotion_decisions');
    expect(source).toContain('baseline_harness_version INTEGER NOT NULL');
    expect(source).toContain('candidate_harness_version INTEGER NOT NULL');
    expect(source).toContain('baseline_run_id TEXT NOT NULL');
    expect(source).toContain('candidate_run_id TEXT NOT NULL');
    expect(source).toContain("decision IN ('promote','reject')");
    expect(source).toContain('CHECK (baseline_run_id <> candidate_run_id)');
  });
});
