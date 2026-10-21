import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mirrorWorkerProjectMutation, type WorkerProjectMirrorMutation } from './workbench-project-derived-mirror.js';

const root = '/synthetic/project';
const mutations: WorkerProjectMirrorMutation[] = [
  { kind: 'upload', hostPath: root + '/file', sourcePath: '/synthetic/staging' },
  { kind: 'write-text', hostPath: root + '/file', content: 'replacement' },
  { kind: 'mkdir', hostPath: root + '/folder' },
  { kind: 'delete', hostPath: root + '/file' },
  { kind: 'rename', oldHostPath: root + '/a', newHostPath: root + '/b' },
  { kind: 'copy', sourceHostPath: root + '/a', targetHostPath: root + '/b' },
];
afterEach(() => vi.restoreAllMocks());
describe('automatic mirror replay is disabled without proven separate storage', () => {
  for (const workerBaseUrl of ['http://127.0.0.1:43125', 'https://worker.example.com']) {
    it.each(mutations)('does not replay $kind for ' + workerBaseUrl, mutation => {
      const methods = ['mkdirSync', 'writeFileSync', 'copyFileSync', 'rmSync', 'renameSync', 'cpSync', 'mkdtempSync'] as const;
      const spies = methods.map(method => vi.spyOn(fs, method).mockImplementation(() => { throw new Error('unexpected filesystem mutation'); }));
      mirrorWorkerProjectMutation({ projectId: 'synthetic', projectRoot: root, relativePath: '.', workerId: 'worker', workerBaseUrl }, mutation);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    });
  }
});
