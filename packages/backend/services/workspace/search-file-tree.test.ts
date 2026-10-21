import { describe, expect, it } from 'vitest';
import { searchFileTree } from './search-file-tree.js';

describe('bounded file name search', () => {
  it('continues after an inaccessible child and marks partial results', async () => {
    const result = await searchFileTree('/project', 'needle', async directory => {
      if (directory === '/project/private') throw Object.assign(new Error('denied'), { code: 'EACCES' });
      if (directory === '/project') return [
        { name: 'private', path: '/project/private', isDirectory: true },
        { name: 'needle.txt', path: '/project/needle.txt', isDirectory: false },
      ];
      return [];
    });
    expect(result.partial).toBe(true);
    expect(result.results.map(entry => entry.name)).toEqual(['needle.txt']);
  });
  it('does not swallow root access denial or membership revocation', async () => {
    await expect(searchFileTree('/project', 'needle', async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); })).rejects.toThrow('denied');
    await expect(searchFileTree('/project', 'needle', async directory => {
      if (directory === '/project') return [{ name: 'child', path: '/project/child', isDirectory: true }];
      throw new Error('PROJECT_FILE_SOURCE_ACCESS_REVOKED');
    })).rejects.toThrow('PROJECT_FILE_SOURCE_ACCESS_REVOKED');
  });
});
