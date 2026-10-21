import fs from 'node:fs';
import path from 'node:path';
import { linuxPathDirectoryFlags } from './linux-path-descriptor.js';

const protectedNames = new Set(['.ssh','.git','.claude','.audit','.temp-uploads','.worktrees','.tower-run-credentials','.tower-credentials','.credentials']);
function check(parts: string[]) {
  if(parts.some(p=>protectedNames.has(p)||p==='.env'||p.startsWith('.env.')||p==='.mcp.json')) throw new Error('WORKSPACE_READ_PROTECTED_PATH');
}
/** Resolve internal aliases using pinned parent descriptors. This returns a candidate,
 * not authority: the consumer MUST reopen every component with O_NOFOLLOW.
 * Outside targets are rejected at every hop, even if a later link comes back in. */
export function resolveInternalReadAlias(root: string, relative: string): string {
  if(!path.isAbsolute(root)||root==='/'||path.resolve(root)!==root||!relative||path.isAbsolute(relative)||/[\\\x00-\x1f]/.test(relative)||relative.split('/').some(p=>!p||p==='.'||p==='..')) throw new Error('WORKSPACE_READ_PATH_INVALID');
  let parts=relative.split('/');check(parts);
  for(let hops=0;hops<=40;hops++){
    let fd=fs.openSync('/',linuxPathDirectoryFlags());let restart=false;
    try{
      for(const segment of root.split('/').filter(Boolean)){
        const next=fs.openSync(`/proc/self/fd/${fd}/${segment}`,linuxPathDirectoryFlags());fs.closeSync(fd);fd=next;
      }
      for(let i=0;i<parts.length;i++){
        const entry=`/proc/self/fd/${fd}/${parts[i]}`;
        const st=fs.lstatSync(entry);
        if(st.isSymbolicLink()){
          const target=fs.readlinkSync(entry);
          if(/[\\\x00-\x1f]/.test(target))throw new Error('WORKSPACE_READ_PATH_INVALID');
          check(target.split('/'));
          const destination=path.resolve(root,...parts.slice(0,i),target);
          if(destination!==root&&!destination.startsWith(root+'/'))throw new Error('WORKSPACE_READ_ALIAS_OUTSIDE_PROJECT');
          const next=[...path.relative(root,destination).split('/').filter(Boolean),...parts.slice(i+1)];check(next);
          if(!next.length)throw new Error('WORKSPACE_READ_UNSAFE_TARGET');
          parts=next;restart=true;break;
        }
        if(i<parts.length-1){const next=fs.openSync(entry,linuxPathDirectoryFlags());fs.closeSync(fd);fd=next;}
      }
      if(!restart)return parts.join('/');
    }finally{fs.closeSync(fd);}
  }
  throw new Error('WORKSPACE_READ_ALIAS_LOOP');
}
