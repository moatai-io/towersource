import { describe, expect, it } from 'vitest';
import { normalizeChannelToolName, validateChannelResponseProvenance } from './channel-response-provenance.js';

describe('channel response provenance gate', () => {
  it('accepts a matching authority snapshot with audience-safe tools', () => {
    expect(validateChannelResponseProvenance({
      expectedAuthorityFingerprint: 'same',
      provenance: { authorityFingerprint: 'same', tools: [{ name: 'read' }, { name: 'WebSearch' }] },
    })).toEqual({ allowed: true });
  });

  it('fails closed when provenance is missing', () => {
    expect(validateChannelResponseProvenance({ expectedAuthorityFingerprint: 'same' })).toMatchObject({ allowed: false });
  });

  it('blocks publication when audience/resource authority changed during execution', () => {
    expect(validateChannelResponseProvenance({
      expectedAuthorityFingerprint: 'new',
      provenance: { authorityFingerprint: 'old', tools: [] },
    })).toMatchObject({ allowed: false, reason: expect.stringContaining('authority changed') });
  });

  it('blocks connectors and other tools without a channel audience authority model', () => {
    expect(validateChannelResponseProvenance({
      expectedAuthorityFingerprint: 'same',
      provenance: { authorityFingerprint: 'same', tools: [{ name: 'mcp__gws__gmail_search' }] },
    })).toMatchObject({ allowed: false, reason: expect.stringContaining('not audience-safe') });
  });

  it('normalizes Pi snake-case file tool names', () => {
    expect(normalizeChannelToolName('web_search')).toBe('WebSearch');
  });
});
