import { describe, expect, it } from 'vitest';
import { verifyPdfCanaryPages } from './pdf-canary-verdict.js';
const fixture = { file: 'ALPHA.pdf', codes: Array.from({length:100},(_,i)=>i===38?'648DE8':i===0?'5B8EB4':i===99?'FA9941':'000000') };
describe('PDF canary requested-page verdict', () => {
  it('does not pass page39 because first/last happen to be correct', () => {
    expect(verifyPdfCanaryPages({fixtures:[fixture],pages:[39],observations:[{source:'ALPHA.pdf',pages:[39,1,100]}],answer:'| 39 | 64BDE8 |\n| 1 | 5B8EB4 |\n| 100 | FA9941 |'})).toBe(false);
  });
  it('requires matching page association and actual source requery', () => {
    expect(verifyPdfCanaryPages({fixtures:[fixture],pages:[39],observations:[{source:'ALPHA.pdf',pages:[39]}],answer:'| ALPHA.pdf | 39 | `648DE8` |'})).toBe(true);
    expect(verifyPdfCanaryPages({fixtures:[fixture],pages:[39],observations:[{source:'ALPHA.pdf',pages:[1]}],answer:'Page 39: 648DE8'})).toBe(false);
    expect(verifyPdfCanaryPages({fixtures:[fixture],pages:[39],observations:[{source:'ALPHA.pdf',pages:[39]}],answer:'Page 40: 648DE8'})).toBe(false);
  });
  it('accepts labeled first and last rows', () => {
    expect(verifyPdfCanaryPages({fixtures:[fixture],pages:[1,100],observations:[{source:'ALPHA.pdf',pages:[1,100]}],answer:'| 1 (first) | `5B8EB4` |\n| 100 (last) | `FA9941` |'})).toBe(true);
  });
});
