/** Installation-selected ACL binary; never search a Project-controlled PATH. */
import fs from 'node:fs';
import path from 'node:path';

export function resolveNewProjectAclExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return validateAclExecutable(env.TOWER_PROJECT_SETFACL_BIN ?? '/usr/bin/setfacl', 'setfacl');
}

/** Read and write ACL tools must both be installation-owned, never resolved via PATH. */
export function resolveProjectAclExecutables(env: NodeJS.ProcessEnv = process.env): { getfacl: string; setfacl: string } {
  const setfacl = resolveNewProjectAclExecutable(env);
  const getfacl = validateAclExecutable(path.join(path.dirname(setfacl), 'getfacl'), 'getfacl');
  return { getfacl, setfacl };
}

function validateAclExecutable(executable: string, name: 'getfacl' | 'setfacl'): string {
  const nix = new RegExp(`^/nix/store/[a-z0-9]{32}-acl-[A-Za-z0-9.+_-]+/bin/${name}$`).test(executable);
  if (executable !== `/usr/bin/${name}` && !nix) throw new Error('NEW_PROJECT_ACL_EXECUTABLE_UNTRUSTED');
  try {
    const components = ['/'];
    for (const part of executable.split('/').filter(Boolean)) components.push(path.join(components.at(-1)!, part));
    for (const component of components) {
      const stat = fs.lstatSync(component);
      // Multi-user Nix stores can be root-owned 1775; sticky protects the
      // root-owned immutable package child. Package/bin/binary remain nonwritable.
      const stickyStore = nix && component === '/nix/store' && (stat.mode & 0o1000) !== 0 && (stat.mode & 0o002) === 0;
      if (stat.uid !== 0 || stat.isSymbolicLink() || ((stat.mode & 0o022) !== 0 && !stickyStore)
        || (component === executable ? !stat.isFile() || (stat.mode & 0o6000) !== 0 : !stat.isDirectory())) {
        throw new Error('untrusted metadata');
      }
    }
    fs.accessSync(executable, fs.constants.X_OK);
    return executable;
  } catch { throw new Error('NEW_PROJECT_ACL_EXECUTABLE_UNTRUSTED'); }
}
