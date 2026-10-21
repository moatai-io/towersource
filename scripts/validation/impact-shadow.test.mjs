import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareSelection } from './impact-shadow.mjs';
test('surfaces text dependencies absent from import selection without skipping anything', () => {
 const result = compareSelection({ root: '/fixture', changedPaths: ['scripts/upgrade'], selectedFiles: ['/fixture/selected.test.ts'], testFiles: ['selected.test.ts','missing.test.ts'], read: () => "readFileSync('scripts/upgrade')" });
 assert.equal(result.mode,'shadow-only'); assert.equal(result.selectedCount,1);
 assert.deepEqual(result.unselectedTextLinks.map(link => link.file), ['missing.test.ts']);
});
test('empty changed set does not claim text dependencies', () => {
 const result = compareSelection({ root: '/fixture', changedPaths: [], selectedFiles: [], testFiles: ['test.test.ts'], read: () => 'text' });
 assert.equal(result.textLinked.length,0);
});
