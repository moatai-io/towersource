import type { Readable } from 'node:stream';
/** Launcher-owned pipe reader. Never writes to disk. On overflow keep draining so
 * a blocked writer cannot prevent cgroup termination; result becomes unusable.
 * Caller must terminate the owned cgroup before finish. EOF alone is not ownership proof.
 */
export function collectWorkstationOutput(stream: Readable, limit = 524288) {
 if(!Number.isSafeInteger(limit)||limit<1||limit>1048576)throw new Error('OUTPUT_LIMIT_INVALID');
 const chunks:Buffer[]=[];let retained=0,overflow=false,ended=false,failed=false;
 const data=(value:Buffer|string)=>{const chunk=Buffer.isBuffer(value)?value:Buffer.from(value);const remaining=limit-retained;if(remaining>0){const copy=Buffer.from(chunk.subarray(0,remaining));chunks.push(copy);retained+=copy.length;}if(chunk.length>remaining)overflow=true;};
 stream.on('data',data);stream.on('end',()=>{ended=true;});stream.on('error',()=>{failed=true;});stream.on('close',()=>{if(!ended)failed=true;});
 return {
  state:()=>({retainedBytes:retained,overflow,ended,failed}),
  finish(){if(failed)throw new Error('OUTPUT_READER_FAILED');if(!ended)throw new Error('OUTPUT_WRITERS_STILL_OPEN');if(overflow)throw new Error('OUTPUT_LIMIT_EXCEEDED');return Buffer.concat(chunks,retained).toString('utf8');},
  dispose(){stream.destroy();chunks.length=0;retained=0;},
 };
}
