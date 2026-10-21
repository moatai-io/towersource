import { describe, it, expect } from 'vitest';
import { AppAuthority } from './app-authority';
const principal = { userId: 'u', projectId: 'p', sessionId: 's' };
describe('experimental app authority', () => {
  it('grants only the server-policy intersection', async () => {
    const a = new AppAuthority(async () => true);
    expect(await a.register('i', principal, ['read','write'], ['read'])).toEqual(['read']);
    await expect(a.callRead('i',principal,'write',async()=>1)).rejects.toThrow('capability_denied');
    expect(await a.callRead('i',principal,'read',async()=>42)).toBe(42);
  });
  for (const key of ['userId','projectId','sessionId']) it(`rejects changed ${key}`, async () => {
    const a = new AppAuthority(async () => true); await a.register('i',principal,['read'],['read']);
    await expect(a.callRead('i',{...principal,[key]:'other'},'read',async()=>1)).rejects.toThrow('access_denied');
  });
  it('rechecks current access and suppresses a revoked response', async () => {
    let access=true; const a=new AppAuthority(async()=>access); await a.register('i',principal,['read'],['read']);
    access=false; await expect(a.callRead('i',principal,'read',async()=>1)).rejects.toThrow('access_denied');
    access=true; await expect(a.callRead('i',principal,'read',async()=>{a.revoke('i');return 'secret'})).rejects.toThrow('access_denied');
  });
  it('rejects duplicate and inaccessible registrations',async()=>{
    const a=new AppAuthority(async()=>true);await a.register('i',principal,[],[]);await expect(a.register('i',principal,[],[])).rejects.toThrow('invalid_instance');
    await expect(new AppAuthority(async()=>false).register('x',principal,[],[])).rejects.toThrow('access_denied');
  });
});
