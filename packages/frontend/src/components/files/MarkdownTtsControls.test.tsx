// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownTtsControls, markdownToSpeakableText, splitSpeakableText } from './MarkdownTtsControls';

class MockSpeechSynthesisUtterance {
  text: string;
  lang = '';
  rate = 1;
  pitch = 1;
  volume = 1;
  voice: SpeechSynthesisVoice | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(text: string) {
    this.text = text;
  }
}

describe('markdownToSpeakableText', () => {
  it('removes noisy markdown syntax while preserving readable prose', () => {
    const result = markdownToSpeakableText(`---
title: Sample
---
# Tower TTS

- API 문서와 [GitHub 링크](https://github.com/example/repo)를 확인합니다.

\`MD\` 파일 안의 URL https://example.com 은 생략합니다.

\`\`\`ts
console.log('noise');
\`\`\`
`);

    expect(result).toContain('Tower 티티에스');
    expect(result).toContain('에이피아이 문서와 깃허브 링크를 확인합니다.');
    expect(result).toContain('마크다운 파일 안의 유알엘 링크 은 생략합니다.');
    expect(result).toContain('코드 블록은 생략합니다.');
    expect(result).not.toContain('title: Sample');
    expect(result).not.toContain('console.log');
    expect(result).not.toContain('https://example.com');
  });
});

describe('splitSpeakableText', () => {
  it('splits long text into browser-safe utterance chunks', () => {
    const long = `${'가'.repeat(1700)}\n\n${'나'.repeat(100)}`;
    const chunks = splitSpeakableText(long);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 1600)).toBe(true);
  });
});

describe('MarkdownTtsControls', () => {
  let synth: {
    paused: boolean;
    speaking: boolean;
    pending: boolean;
    speak: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    getVoices: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    synth = {
      paused: false,
      speaking: false,
      pending: false,
      speak: vi.fn(() => {
        synth.speaking = true;
        synth.paused = false;
      }),
      pause: vi.fn(() => {
        synth.paused = true;
      }),
      resume: vi.fn(() => {
        synth.paused = false;
        synth.speaking = true;
      }),
      cancel: vi.fn(() => {
        synth.paused = false;
        synth.speaking = false;
        synth.pending = false;
      }),
      getVoices: vi.fn(() => []),
    };
    Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: MockSpeechSynthesisUtterance, configurable: true });
    Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', { value: MockSpeechSynthesisUtterance, configurable: true });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, 'speechSynthesis');
    Reflect.deleteProperty(window, 'SpeechSynthesisUtterance');
    Reflect.deleteProperty(globalThis, 'SpeechSynthesisUtterance');
  });

  it('turns the play button into pause/resume instead of restarting from the beginning', async () => {
    render(<MarkdownTtsControls content={'# 제목\n\n첫 문장입니다.'} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Markdown 본문 읽어주기' }));

    expect(synth.cancel).toHaveBeenCalledTimes(1);
    expect(synth.speak).toHaveBeenCalledTimes(1);

    fireEvent.click(await screen.findByRole('button', { name: '일시정지' }));

    expect(synth.pause).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: '읽기 재개' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '읽기 재개' }));

    expect(synth.resume).toHaveBeenCalledTimes(1);
    expect(synth.speak).toHaveBeenCalledTimes(1);
  });

  it('does not pause an idle browser speech session on unmount', async () => {
    const { unmount } = render(<MarkdownTtsControls content={'# 제목\n\n본문'} />);

    await screen.findByRole('button', { name: 'Markdown 본문 읽어주기' });
    unmount();

    expect(synth.pause).not.toHaveBeenCalled();
    expect(synth.cancel).not.toHaveBeenCalled();
  });

  it('pauses instead of canceling when playback is interrupted by unmount', async () => {
    const { unmount } = render(<MarkdownTtsControls content={'# 제목\n\n본문'} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Markdown 본문 읽어주기' }));
    unmount();

    expect(synth.pause).toHaveBeenCalledTimes(1);
    expect(synth.cancel).toHaveBeenCalledTimes(1);
  });

  it('restores a paused browser speech session after the controls remount', async () => {
    const first = render(<MarkdownTtsControls content={'# 제목\n\n본문'} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Markdown 본문 읽어주기' }));
    first.unmount();

    render(<MarkdownTtsControls content={'# 제목\n\n본문'} />);

    fireEvent.click(await screen.findByRole('button', { name: '읽기 재개' }));

    expect(synth.resume).toHaveBeenCalledTimes(1);
    expect(synth.speak).toHaveBeenCalledTimes(1);
  });

  it('pauses instead of restarting when content changes mid-playback', async () => {
    const { rerender } = render(<MarkdownTtsControls content={'# 제목\n\n첫 본문'} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Markdown 본문 읽어주기' }));
    rerender(<MarkdownTtsControls content={'# 제목\n\n수정된 본문'} />);

    await waitFor(() => expect(synth.pause).toHaveBeenCalledTimes(1));
    expect(synth.speak).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '읽기 재개' })).toBeTruthy();
  });
});
