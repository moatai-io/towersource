import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectPiWrapperContexts } from './pi-tool-wrapper-contract.mjs';
const source = options => `wrapPiTools(piTools, guard, ${options}); wrapPiTools([...piTools, ...customTools, ...mcpTools, ...projectMcpTools], guard, ${options});`;
test('accepts legacy and expanded named options in either order', () => {
  for (const options of ['{ projectRoot: sessionProjectRoot }', '{ projectRoot: sessionProjectRoot, resolveGuard }', '{ resolveGuard, projectRoot: sessionProjectRoot, }']) assert.deepEqual(inspectPiWrapperContexts(source(options)), { builtins:true, custom:true, all:true });
});
test('rejects absent, wrong, shorthand and overwritten roots', () => {
  for (const options of ['{}','{resolveGuard}','{projectRoot: otherRoot}','{projectRoot}','{projectRoot: sessionProjectRoot, ...other}','{...other, projectRoot: sessionProjectRoot}','{projectRoot: sessionProjectRoot, projectRoot: otherRoot}','{projectRoot: sessionProjectRoot, [key]: other}']) assert.equal(inspectPiWrapperContexts(source(options)).all, false, options);
});
test('comments and strings cannot satisfy missing call groups', () => {
  const fake = source('{projectRoot: sessionProjectRoot}');
  for (const text of [`/* ${fake} */`, JSON.stringify(fake), '']) {
    assert.equal(inspectPiWrapperContexts(text).builtins, false);
    assert.equal(inspectPiWrapperContexts(text).custom, false);
  }
});
test('checks additional capability wrappers and duplicate bad calls', () => {
  assert.equal(inspectPiWrapperContexts(source('{projectRoot: sessionProjectRoot}')+';wrapPiTools(capabilities, guard, {});').all, false);
  assert.equal(inspectPiWrapperContexts(source('{projectRoot: sessionProjectRoot}')+';wrapPiTools(piTools, guard, {});').builtins, false);
});
