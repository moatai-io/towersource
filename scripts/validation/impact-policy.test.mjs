import { test } from 'node:test';
import assert from 'node:assert/strict';
import { impactPolicy } from './impact-policy.mjs';
const check = (path, status='M', selectedCount=1) => impactPolicy({ changes:[{path,status}],selectedCount });
test('ordinary application edits are candidates, not active skips', () => {
 assert.equal(check('packages/backend/engines/pi/model-registry.ts').candidate,'impact-selection');
 assert.equal(check('packages/frontend/src/button.tsx').mode,'shadow-only');
});
test('deletion and rename require existing validation', () => {
 for (const status of ['D','R100','T','U']) assert.equal(check('packages/backend/example.ts',status).candidate,'existing-validation');
});
test('runtime/configuration/shell/unknown changes fall back', () => {
 for (const path of ['scripts/nix-app/upgrade','package.json','packages/backend/config.ts','packages/backend/db/migrations/001.ts','packages/backend/scripts/job.ts','unknown.ts']) assert.equal(check(path).candidate,'existing-validation',path);
});
test('empty or failed discovery never authorizes selection', () => {
 assert.equal(check('packages/backend/example.ts','M',0).candidate,'existing-validation');
 assert.equal(impactPolicy({changes:[],selectedCount:0}).candidate,'existing-validation');
 assert.equal(impactPolicy({changes:[{path:'packages/backend/example.ts',status:'M'}],selectedCount:2,discoveryError:true}).candidate,'existing-validation');
});
