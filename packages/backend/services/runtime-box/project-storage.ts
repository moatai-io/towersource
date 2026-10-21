import fs from 'node:fs';
import path from 'node:path';

export type ProjectStorageNamespace = 'shared' | 'managed-readonly' | 'private';

const MANAGED = new Set(['.tower', '.git']);
const PRIVATE = new Set(['.tower-run-credentials', '.env']);

/** Pure path-policy boundary. This module does not mutate ACLs or elevate identity. */
export class ProjectStorage {
  readonly root: string;
  constructor(root: string) {
    if (!path.isAbsolute(root) || path.resolve(root) !== root || root === '/') throw new Error('PROJECT_STORAGE_ROOT_INVALID');
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(root) !== root) throw new Error('PROJECT_STORAGE_ROOT_UNTRUSTED');
    this.root = root;
  }

  resolve(relativePath: string): { absolutePath: string; namespace: ProjectStorageNamespace } {
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\0')) throw new Error('PROJECT_STORAGE_PATH_INVALID');
    const normalized = path.normalize(relativePath);
    if (normalized === '.' || normalized === '..' || normalized.startsWith(`..${path.sep}`)) throw new Error('PROJECT_STORAGE_PATH_ESCAPE');
    const parts = normalized.split(path.sep).filter(Boolean);
    const first = parts[0];
    const namespace: ProjectStorageNamespace = PRIVATE.has(first) || first === '.env' ? 'private'
      : MANAGED.has(first) ? 'managed-readonly' : 'shared';
    return { absolutePath: path.join(this.root, normalized), namespace };
  }

  assertMutation(relativePath: string, requested: ProjectStorageNamespace = 'shared'): string {
    const target = this.resolve(relativePath);
    if (target.namespace !== requested) throw new Error(`PROJECT_STORAGE_NAMESPACE_DENIED:${target.namespace}`);
    this.assertExistingAncestors(target.absolutePath);
    return target.absolutePath;
  }

  private assertExistingAncestors(target: string): void {
    let current = path.dirname(target);
    while (current !== this.root) {
      const stat = fs.lstatSync(current, { throwIfNoEntry: false });
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('PROJECT_STORAGE_ANCESTOR_UNTRUSTED');
      current = path.dirname(current);
      if (!current.startsWith(`${this.root}${path.sep}`) && current !== this.root) throw new Error('PROJECT_STORAGE_PATH_ESCAPE');
    }
  }
}
