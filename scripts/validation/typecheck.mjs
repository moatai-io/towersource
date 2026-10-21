import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

// Independent noEmit projects may run together; do not overlap tests/build.
export async function runTypechecks({ launch = spawn, log = console.log, projects = ['backend', 'frontend'] } = {}) {
  const compiler = fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url));
  if (!projects.length || projects.some(project => !['backend', 'frontend'].includes(project))) throw Error('Invalid typecheck projects');
  const results = await Promise.all(projects.map(project => new Promise(resolve => {
    const start = performance.now();
    let child;
    try { child = launch(process.execPath, [compiler, '--noEmit', '-p', `tsconfig.${project}.json`], { stdio: 'inherit', shell: false }); }
    catch { resolve(1); return; }
    let completed = false;
    const finish = code => {
      if (completed) return;
      completed = true;
      log(`[typecheck:${project}] ${Math.round(performance.now() - start)}ms, exit=${code}`);
      resolve(code);
    };
    child.once('error', () => finish(1));
    child.once('exit', (code, signal) => finish(signal || code === null ? 1 : code));
  })));
  return results.find(code => code !== 0) ?? 0;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== '--frontend-only')) throw Error('usage: typecheck.mjs [--frontend-only]');
  process.exitCode = await runTypechecks(args.length ? { projects: ['frontend'] } : {});
}
