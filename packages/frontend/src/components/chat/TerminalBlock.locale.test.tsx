// @vitest-environment jsdom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';
import TerminalBlock from './TerminalBlock';

describe('terminal chrome localization', () => {
  it('uses Korean fallback chrome while preserving command, output, and custom title', async () => {
    const i18n = createInstance();
    await i18n.init({ lng: 'ko', fallbackLng: false, resources: { ko: { chat: { openFile: '파일 열기: {{path}}', copied: '복사됨' } } }, interpolation: { escapeValue: false } });
    const render = (title?: string) => renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <TerminalBlock raw={JSON.stringify({ title, commands: [{ cmd: 'echo ready', output: 'ready' }] })} fallbackCode="" />
      </I18nextProvider>,
    );
    const html = render();
    expect(html).toContain('터미널');
    expect(html).toContain('클릭하여 명령 복사');
    expect(html).toContain('출력 숨기기');
    expect(html).toContain('echo ready');
    expect(render('Build output')).toContain('Build output');
  });
});
