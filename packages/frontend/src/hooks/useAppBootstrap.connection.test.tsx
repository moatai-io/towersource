// @vitest-environment jsdom
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { useAuthBootstrap, useBrandingBootstrap } from './useAppBootstrap';

let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  localStorage.clear();
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
});

it.each(['', 'https://tower.example.com/'])('routes auth and branding boot requests to configured base %s', async base => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubEnv('VITE_API_URL', base);
  localStorage.setItem('token', 'synthetic');
  const fetchMock = vi.fn(async (url: string) => ({ status: 200, ok: true, json: async () => url.endsWith('/auth/status') ? { authEnabled: true, hasUsers: true } : {} }));
  vi.stubGlobal('fetch', fetchMock);
  const setToken = vi.fn();
  function Probe() { useAuthBootstrap('synthetic', setToken); useBrandingBootstrap(); return null; }
  const container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(createElement(Probe)); });
  const prefix = base.replace(/\/$/, '');
  expect(fetchMock).toHaveBeenCalledWith(`${prefix}/api/auth/status`);
  expect(fetchMock).toHaveBeenCalledWith(`${prefix}/api/auth/check`, { headers: { Authorization: 'Bearer synthetic' } });
  expect(fetchMock).toHaveBeenCalledWith(`${prefix}/api/branding/status`, { cache: 'no-store' });
  expect(setToken).not.toHaveBeenCalled();
});
