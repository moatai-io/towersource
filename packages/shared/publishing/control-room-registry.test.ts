import {it,expect} from 'vitest';
import {addControlRoomEntry} from './control-room-registry';
const entry={slug:'demo',title:'Demo'};
it('preserves unrelated entries and metadata',()=>{const original={version:1,note:'keep',dashboards:[{slug:'other',title:'Other',note:'keep too'}]};const result=JSON.parse(addControlRoomEntry(JSON.stringify(original),entry));expect(result.note).toBe('keep');expect(result.dashboards[0]).toEqual(original.dashboards[0]);expect(result.dashboards).toHaveLength(2)});
it('is idempotent without reformatting',()=>{const raw=JSON.stringify({version:1,dashboards:[entry]});expect(addControlRoomEntry(raw,entry)).toBe(raw)});
it('rejects changing a registered title implicitly',()=>expect(()=>addControlRoomEntry(JSON.stringify({version:1,dashboards:[entry]}),{...entry,title:'Other'})).toThrow('registration_conflict'));
it('does not reset corrupt registries',()=>expect(()=>addControlRoomEntry('{',entry)).toThrow());
