import {expect,it} from 'vitest';
import {buildResumeMessages} from './resume-history.js';
it('preserves stable identities and complete content without a forty-message cutoff',()=>{
 const history=Array.from({length:100},(_,i)=>({id:`m${i}`,role:i%2?'assistant':'user',body:'text'.repeat(1000)}));
 const result=buildResumeMessages(history);expect(result).toHaveLength(100);expect(result[99].id).toBe('m99');expect(result[0].content[0].text).toBe(history[0].body);
});
it('never imports duplicate identity or tool/hidden roles into native conversation',()=>{
 expect(buildResumeMessages([{id:'a',role:'user',body:'one'},{id:'a',role:'user',body:'again'},{id:'t',role:'tool',body:'private'}])).toHaveLength(1);
});
