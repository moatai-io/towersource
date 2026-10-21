import { describe, expect, it } from 'vitest';
import { configuredPiRequestBodyLimit, DEFAULT_PI_REQUEST_BODY_BYTES, estimateProviderInput, inspectProviderRequestBody } from './provider-request-budget.js';

describe('separate provider image tokens and transport bytes', () => {
  it.each([
    (data: string) => ({ type: 'input_image', image_url: `data:image/png;base64,${data}` }),
    (data: string) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } }),
    (data: string) => ({ type: 'image', source: { type: 'base64', data, media_type: 'image/png' } }),
  ])('does not count image Base64 as ordinary text tokens', image => {
    const small = { input: [{ role: 'user', content: [image('AAAA')] }] };
    const large = { input: [{ role: 'user', content: [image('A'.repeat(1000000))] }] };
    expect(estimateProviderInput(large)).toEqual(estimateProviderInput(small));
    expect(estimateProviderInput(large).imageItems).toBe(1);
    expect(inspectProviderRequestBody(JSON.stringify(large), 10000).rejected).toBe(true);
  });
  it('counts all parallel and historical images without dropping or mutating them', () => {
    const body = { input: Array.from({ length: 10 }, (_, i) => ({ role: i < 5 ? 'user' : 'tool', content: [{ type: 'input_image', image_url: 'data:image/png;base64,' + 'A'.repeat(3000000) }] })) };
    const before = JSON.stringify(body);
    expect(estimateProviderInput(body).imageItems).toBe(10);
    expect(estimateProviderInput(body).estimatedTokens).toBeLessThan(20000);
    expect(inspectProviderRequestBody(before).rejected).toBe(true);
    expect(JSON.stringify(body)).toBe(before);
  });
  it('counts actual UTF-8 serialized bytes including text, schemas and framing', () => {
    const body = JSON.stringify({ instructions: '한글'.repeat(100), tools: [{ description: 'large schema' }] });
    const bytes = Buffer.byteLength(body);
    expect(inspectProviderRequestBody(body, bytes)).toMatchObject({ requestBytes: bytes, rejected: false });
    expect(inspectProviderRequestBody(body, bytes - 1).rejected).toBe(true);
    expect(estimateProviderInput({ text: 'real text '.repeat(1000) }).estimatedTokens).toBeGreaterThan(2000);
  });
  it('uses a safe positive configuration or defaults without disabling the bound', () => {
    for (const value of ['0', '-1', 'Infinity', 'invalid', '1.2']) expect(configuredPiRequestBodyLimit({ PI_PROVIDER_MAX_REQUEST_BODY_BYTES: value })).toBe(DEFAULT_PI_REQUEST_BODY_BYTES);
    expect(configuredPiRequestBodyLimit({ PI_PROVIDER_MAX_REQUEST_BODY_BYTES: '1000000' })).toBe(1000000);
  });
});
