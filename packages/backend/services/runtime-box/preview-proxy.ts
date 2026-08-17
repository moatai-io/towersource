/**
 * Owns: Project Runtime Box preview WebSocket proxy.
 * Public API: setupRuntimeBoxPreviewWebSocket(server).
 * See README.md for service/preview lifecycle.
 */

import http, { type IncomingMessage, type Server } from 'http';
import type { Socket } from 'net';
import { config } from '../../config.js';
import { verifyToken } from '../auth/auth.js';
import { isProjectMember } from '../pm/project-membership-manager.js';
import { isPrivilegedRole } from '../pm/project-access.js';
import { getPreviewTargetByToken } from './service-registry.js';

function parsePreviewPath(url: string | undefined): { token: string; upstreamPath: string } | undefined {
  const parsed = new URL(url || '/', 'http://localhost');
  const match = parsed.pathname.match(/^\/api\/runtime-box\/preview\/([^/]+)(\/.*)?$/);
  if (!match) return undefined;
  const token = decodeURIComponent(match[1]);
  // Keep the full preview path for upstream. Runtime Box services that need
  // browser asset/HMR correctness can read TOWER_RUNTIME_BOX_PREVIEW_BASE and
  // serve under this path.
  return { token, upstreamPath: `${parsed.pathname}${parsed.search}` };
}

function extractUpgradeToken(req: IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);

  const parsed = new URL(req.url || '/', 'http://localhost');
  const queryToken = parsed.searchParams.get('token');
  if (queryToken) return queryToken;

  const cookies = req.headers.cookie || '';
  const match = cookies.match(/(?:^|;\s*)tower_token=([^;]+)/);
  if (match) return decodeURIComponent(match[1]);
  return null;
}

function writeUpgradeError(socket: Socket, status: number, message: string) {
  const body = `${message}\n`;
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\n` +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    '\r\n' +
    body,
  );
  socket.destroy();
}

function serializeHeaders(headers: http.IncomingHttpHeaders): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${key}: ${item}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  return lines.join('\r\n');
}

/**
 * Runtime Box preview용 WebSocket/HMR upgrade proxy.
 * Express middleware는 HTTP upgrade를 받지 못하므로 http.Server에 직접 붙인다.
 */
export function setupRuntimeBoxPreviewWebSocket(server: Server) {
  // `ws` package의 server-bound listener는 path mismatch에서도 socket을 닫을 수 있다.
  // 기존 upgrade listener를 감싸서 Runtime Box preview path는 여기서 독점 처리하고,
  // 나머지만 기존 Tower /ws listener로 넘긴다.
  const existingUpgradeListeners = server.listeners('upgrade');
  server.removeAllListeners('upgrade');

  server.on('upgrade', async (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const parsed = parsePreviewPath(req.url);
    if (!parsed) {
      for (const listener of existingUpgradeListeners) {
        listener.call(server, req, socket, head as any);
      }
      return;
    }

    try {
      const target = await getPreviewTargetByToken(parsed.token);
      if (!target) return writeUpgradeError(socket, 404, 'Runtime Box preview not found or not running');

      if (config.authEnabled) {
        const rawToken = extractUpgradeToken(req);
        const payload = rawToken ? verifyToken(rawToken) : null;
        if (!payload) return writeUpgradeError(socket, 401, 'Auth required');
        if (!isPrivilegedRole(payload.role) && !(await isProjectMember(target.service.project_id, payload.userId))) {
          return writeUpgradeError(socket, 403, 'Access denied');
        }
      }

      const targetUrl = new URL(parsed.upstreamPath, target.targetBaseUrl);
      const headers: http.OutgoingHttpHeaders = { ...req.headers };
      headers.host = targetUrl.host;
      headers['x-forwarded-host'] = req.headers.host;
      headers['x-forwarded-proto'] = 'https';
      headers['x-tower-runtime-box-service-id'] = String(target.service.id);

      const proxyReq = http.request(targetUrl, {
        method: req.method,
        headers,
      });

      proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
        socket.write(
          `HTTP/1.1 ${proxyRes.statusCode || 101} ${proxyRes.statusMessage || 'Switching Protocols'}\r\n` +
          `${serializeHeaders(proxyRes.headers)}\r\n\r\n`,
        );
        if (proxyHead.length > 0) socket.write(proxyHead);
        if (head.length > 0) proxySocket.write(head);
        proxySocket.pipe(socket).pipe(proxySocket);
      });

      proxyReq.on('response', (proxyRes) => {
        const status = proxyRes.statusCode || 502;
        writeUpgradeError(socket, status, proxyRes.statusMessage || 'Upstream did not upgrade');
        proxyRes.resume();
      });

      proxyReq.on('error', (err) => {
        writeUpgradeError(socket, 502, `Runtime Box preview WebSocket proxy failed: ${err.message}`);
      });

      proxyReq.end();
    } catch (err: any) {
      writeUpgradeError(socket, 500, err?.message || 'Runtime Box preview WebSocket error');
    }
  });
}
