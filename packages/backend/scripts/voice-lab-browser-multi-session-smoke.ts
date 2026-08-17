/** Browser smoke for three isolated Voice Lab connections. Never prints auth or LiveKit tokens. */
import { chromium, type BrowserContext } from 'playwright';
import { createSession } from '../services/session/session-manager.js';
import { generateToken } from '../services/auth/auth.js';
import { execute } from '../db/pg-repo.js';

const PROJECT_ID = '7d84f926-1fcd-438d-94dc-a36048636bad';
const USER_ID = 1;
const USERNAME = 'enterpriseai';
const ROLE = 'admin';
const BASE_URL = 'https://desk-dev.tower.example.com/voice-lab';

async function createTestSession(index: number) {
  return createSession(
    `[voice-browser-smoke] ${index}-${Date.now()}`,
    '/home/tower/tower', USER_ID, PROJECT_ID, 'pi', null, null, null,
    'voice-browser-smoke', 'litellm-responses/mini', { visibility: 'private' },
  );
}

async function connectContext(context: BrowserContext, sessionId: string, index: number) {
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text().replace(/[A-Za-z0-9_-]{80,}/g, '[redacted]'));
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  await page.addInitScript(({ token }) => localStorage.setItem('token', token), {
    token: generateToken({ userId: USER_ID, username: USERNAME, role: ROLE }),
  });
  await page.goto(`${BASE_URL}?sessionId=${encodeURIComponent(sessionId)}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '음성 대화 시작' }).click();
  await page.getByRole('button', { name: '음성 대화 종료' }).waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByRole('status').filter({ hasText: /출력:\s*(AI 참가|오디오 수신|재생 중)/ }).waitFor({
    state: 'visible', timeout: 20_000,
  });
  const statusText = await page.getByRole('status').innerText();
  const audio = await page.locator('audio').evaluate((element: HTMLAudioElement) => ({
    autoplay: element.autoplay,
    muted: element.muted,
    paused: element.paused,
    hasSource: Boolean(element.srcObject),
  }));
  const sessionValue = await page.locator('#voice-lab-session').inputValue();
  return {
    index,
    connected: /연결됨|마이크 게시됨|마이크 소리/.test(statusText),
    sessionMatched: sessionValue === sessionId,
    playbackState: statusText.match(/출력:\s*([^\n]+)/)?.[1] || 'unknown',
    audio,
    consoleErrors,
  };
}

async function main() {
  const sessions = await Promise.all([1, 2, 3].map(createTestSession));
  const ids = sessions.map((session) => session.id);
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
    ],
  });
  const contexts: BrowserContext[] = [];
  try {
    for (let index = 0; index < ids.length; index += 1) {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['microphone'] });
      contexts.push(context);
    }
    const results = await Promise.all(contexts.map((context, index) => connectContext(context, ids[index], index + 1)));
    const connectedPass = results.every((result) => result.connected && result.sessionMatched);
    const consolePass = results.every((result) => result.consoleErrors.length === 0);
    const audioElementsPass = results.every((result) => result.audio.autoplay && !result.audio.muted);
    const remoteAudioPass = results.every((result) => /AI 참가|오디오 수신|재생 중/.test(result.playbackState));
    const distinctPass = new Set(ids).size === ids.length;
    console.log([
      `browser_connections=${connectedPass ? 'pass' : 'fail'}`,
      `distinct_sessions=${distinctPass ? 'pass' : 'fail'}`,
      `console_errors=${consolePass ? 'pass' : 'fail'}`,
      `audio_elements=${audioElementsPass ? 'pass' : 'fail'}`,
      `remote_audio=${remoteAudioPass ? 'pass' : 'fail'}`,
      `playback_states=${results.map((result) => result.playbackState.replace(/\s+/g, '_')).join(',')}`,
    ].join(' '));
    if (!connectedPass || !distinctPass || !consolePass || !audioElementsPass || !remoteAudioPass) {
      for (const result of results) {
        if (result.consoleErrors.length) console.error(`context_${result.index}_errors=${result.consoleErrors.join(' | ')}`);
      }
      process.exitCode = 1;
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close().catch(() => undefined)));
    await browser.close().catch(() => undefined);
    await execute('UPDATE sessions SET archived=1 WHERE id=ANY($1::text[])', [ids]);
  }
}

main().then(() => process.exit(process.exitCode || 0)).catch((error) => {
  console.error(`voice_lab_browser_smoke=fail error=${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
