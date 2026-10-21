/** HTTPS-only MCP/OAuth fetch. DNS answers are vetted and pinned at connection time. */
import dns from 'node:dns/promises';
import https from 'node:https';
import { Readable } from 'node:stream';
import ipaddr from 'ipaddr.js';

export function validateMcpPublicUrl(value: string | URL): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash
    || (url.port && url.port !== '443') || !url.hostname || url.hostname.endsWith('.local')
    || url.hostname === 'localhost' || url.hostname.endsWith('.localhost')) {
    throw new Error('MCP requires a public HTTPS URL without credentials, fragments or custom ports');
  }
  return url;
}

export function isPublicMcpAddress(address: string): boolean {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}

export async function assertMcpPublicUrl(value: string | URL): Promise<URL> {
  const url = validateMcpPublicUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(a => !isPublicMcpAddress(a.address))) {
    throw new Error('MCP endpoint resolves to a non-public network');
  }
  return url;
}

/** No automatic redirects; OAuth discovery/token/resource URLs each pass the same SSRF boundary. */
export async function projectMcpFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  if (input instanceof Request) throw new Error('Request objects are unsupported');
  const url = validateMcpPublicUrl(input);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(a => !isPublicMcpAddress(a.address))) throw new Error('Non-public MCP address');
  const pinned = addresses[0];
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
  if (headers.host) throw new Error('Host overrides are forbidden');
  const body = init.body;
  if (body !== undefined && body !== null && typeof body !== 'string' && !(body instanceof URLSearchParams) && !(body instanceof Uint8Array)) {
    throw new Error('Unsupported MCP request body');
  }
  return new Promise<Response>((resolve, reject) => {
    const req = https.request(url, {
      method: init.method ?? 'GET', headers,
      lookup: (_host, options, callback) => {
        // Node autoSelectFamily asks lookup for all answers; return only the vetted pin.
        if (options.all) (callback as any)(null, [pinned]);
        else callback(null, pinned.address, pinned.family);
      },
    }, response => {
      clearTimeout(timer);
      const outHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) for (const item of value) outHeaders.append(name, item);
        else if (value !== undefined) outHeaders.set(name, value);
      }
      const status = response.statusCode ?? 502;
      if (status >= 300 && status < 400) {
        response.destroy(); reject(new Error('MCP redirects are forbidden')); return;
      }
      const noBody = status === 204 || status === 205 || init.method === 'HEAD';
      resolve(new Response(noBody ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, headers: outHeaders }));
    });
    const timer = setTimeout(() => req.destroy(new Error('MCP request timed out')), 15_000);
    const abort = () => req.destroy(new Error('MCP request aborted'));
    init.signal?.addEventListener('abort', abort, { once: true });
    req.on('error', reject);
    req.on('close', () => { clearTimeout(timer); init.signal?.removeEventListener('abort', abort); });
    if (init.signal?.aborted) { abort(); return; }
    req.end(body instanceof URLSearchParams ? body.toString() : body);
  });
}
