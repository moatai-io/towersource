import { expect, it } from 'vitest';
import { updateDictation } from './dictation-insertion';
it('inserts at selection and replaces only unedited transcription', () => {
 const first = updateDictation('앞 뒤', '말', {start:2,end:2,owned:'',transcript:'',snapshot:'앞 뒤'});
 expect(first.value).toBe('앞 말뒤');
 expect(updateDictation(first.value,'말씀',first.state).value).toBe('앞 말씀뒤');
});
it('preserves user edits and adds only new transcript suffix', () => {
 const first = updateDictation('', '오늘', {start:0,end:0,owned:'',transcript:'',snapshot:''});
 expect(updateDictation('내일', '오늘 날씨', first.state).value).toBe('내일 날씨');
 expect(updateDictation('내일', '오늘!', first.state).value).toBe('내일!');
});
it('does not reinsert the full transcript after an edit and multiple deltas', () => {
 const first = updateDictation('', '오늘', {start:0,end:0,owned:'',transcript:'',snapshot:''});
 const second = updateDictation('내일', '오늘 날씨', first.state);
 const third = updateDictation(second.value, '오늘 날씨 좋다', second.state);
 expect(third.value).toBe('내일 날씨 좋다');
 expect(updateDictation(third.value, '오늘 날씨 좋다', third.state).value).toBe(third.value);
});
it('does not restore deleted text when stop repeats or revises the final result', () => {
 const first = updateDictation('', '원래 문장', {start:0,end:0,owned:'',transcript:'',snapshot:''});
 const deleted = updateDictation('', '원래 문장', first.state);
 expect(deleted.value).toBe('');
 expect(updateDictation('', '원래 문장.', deleted.state).value).toBe('.');
 expect(updateDictation('', '원래의 문장', deleted.state).value).toBe('');
});
