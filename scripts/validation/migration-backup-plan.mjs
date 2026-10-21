import { execFileSync } from 'node:child_process';
import { migrationBackupPolicy } from './migration-backup-policy.mjs';
const [revision, ...paths] = process.argv.slice(2);
if (!/^[a-f0-9]{40}$/.test(revision || '') || paths.some(path => !/^packages\/backend\/db\/migrations\/[^/]+\.sql$/.test(path))) throw Error('Invalid exact migration input');
const read = path => execFileSync('git', ['show', `${revision}:${path}`], { encoding: 'utf8' });
let reviews = {};
try { reviews = JSON.parse(read('scripts/validation/migration-backup-reviews.json')); } catch { /* absent/invalid review fails closed */ }
console.log(JSON.stringify(migrationBackupPolicy(paths.map(path => ({ path, sql: read(path) })), reviews)));
