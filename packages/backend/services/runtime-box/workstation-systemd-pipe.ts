/** systemd 249 systemd-run(1) --pipe passes client stdio FDs to service.
 * This transport deliberately does NOT expose a start acknowledgement: child
 * spawn/exit is not a D-Bus start-job barrier. Manager must acquire identity
 * before releasing its trusted command-start gate. No FIFO and no disk output.
 */
import {spawn} from 'node:child_process';
import {collectWorkstationOutput} from './workstation-bounded-output.js';
export function startSystemdPipe(args:readonly string[]) {
 if(args.some(a=>a.startsWith('--property=StandardOutput=')||a.startsWith('--property=StandardError='))||!args.includes('--'))throw new Error('SYSTEMD_PIPE_SPEC_INVALID');
 const child=spawn('/usr/bin/systemd-run',['--pipe',...args],{stdio:['ignore','pipe','pipe'],env:{PATH:'/usr/bin:/bin',LANG:'C'}});
 const stdout=collectWorkstationOutput(child.stdout),stderr=collectWorkstationOutput(child.stderr);
 const completed=new Promise<{stdout:string;stderr:string}>((resolve,reject)=>{
  child.once('error',()=>reject(new Error('SYSTEMD_PIPE_CLIENT_FAILED')));
  child.once('close',code=>{try{if(code===null)throw new Error('SYSTEMD_PIPE_CLIENT_FAILED');resolve({stdout:stdout.finish(),stderr:stderr.finish()});}catch(error){reject(error);}finally{stdout.dispose();stderr.dispose();}});
 });void completed.catch(()=>{});
 return {completed,
  // Stops only this client, NOT service or descendants. Caller retains journal.
  disconnect(){child.kill('SIGKILL');stdout.dispose();stderr.dispose();},
  outputState:()=>({stdout:stdout.state(),stderr:stderr.state()}),
 };
}
