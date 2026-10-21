import { describe, it, expect } from 'vitest';
import { validateMcpPublicUrl, isPublicMcpAddress } from './project-mcp-network.js';
describe('MCP SSRF boundary', () => {
  it.each(['http://example.com/mcp', 'https://user:pass@example.com/mcp', 'https://example.com:8443/mcp', 'https://localhost/mcp', 'https://api.localhost/mcp', 'https://api.local/mcp', 'https://example.com/mcp#fragment'])('rejects unsafe URL %s', value => {
    expect(() => validateMcpPublicUrl(value)).toThrow();
  });
  it('accepts HTTPS public host syntax', () => { expect(validateMcpPublicUrl('https://example.com/mcp').hostname).toBe('example.com'); });
  it.each(['127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '224.0.0.1', '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1'])('rejects private/reserved address %s', address => {
    expect(isPublicMcpAddress(address)).toBe(false);
  });
  it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])('accepts public unicast %s', address => { expect(isPublicMcpAddress(address)).toBe(true); });
});
