import {beforeEach,expect,it,vi} from 'vitest';
vi.mock('../../db/pg-repo.js',()=>({queryOne:vi.fn()}));
import {queryOne} from '../../db/pg-repo.js';
import {ensurePersonalSecretarySession} from './personal-session.js';
beforeEach(()=>vi.resetAllMocks());
it('uses one private owner session instead of creating one per opening',async()=>{
 vi.mocked(queryOne).mockResolvedValue({id:'stable'});
 expect(await ensurePersonalSecretarySession(7)).toBe('stable');
 expect(await ensurePersonalSecretarySession(7)).toBe('stable');
 expect(queryOne).toHaveBeenCalledWith(expect.stringContaining("ON CONFLICT (user_id) WHERE label='personal_secretary'"),[expect.any(String),7]);
});

it('does not replace ordinary session message reads',async()=>{
 vi.mocked(queryOne).mockResolvedValue(undefined);
 const {readSecretarySessionMessages}=await import('./personal-session.js');
 expect(await readSecretarySessionMessages('ordinary')).toBeNull();
});
