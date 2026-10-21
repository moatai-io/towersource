import {describe,it,expect} from 'vitest';import {visibleSpeakerName} from './useOwnDisplayIdentity';
describe('display name does not alter identity',()=>{const own={id:2,username:'cp_hash',displayName:'사용자'};
it('maps self only including historical messages',()=>{expect(visibleSpeakerName('cp_hash',own)).toBe('사용자');expect(visibleSpeakerName('other',own)).toBe('other');});
it('missing evidence never attributes another message to self',()=>{expect(visibleSpeakerName(undefined,own)).toBeUndefined();expect(visibleSpeakerName('cp_hash',null)).toBe('cp_hash');});});
