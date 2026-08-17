// Owns: browser-native TTS controls for trusted Markdown viewers.
// Public API: MarkdownTtsControls, markdownToSpeakableText.
//
// Keep executable speech code in Tower's viewer chrome, not inside Markdown
// documents. User-authored Markdown is content; this component is trusted UI.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const MAX_UTTERANCE_CHARS = 1600;

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Converts raw Markdown into text that is less annoying to hear through
 * browser-native speechSynthesis. This is intentionally conservative: it
 * skips code/URL noise, names common dev acronyms, and leaves prose intact.
 */
export function markdownToSpeakableText(markdown: string): string {
  return normalizeWhitespace(markdown)
    // Frontmatter is metadata, not body prose.
    .replace(/^---\n[\s\S]*?\n---\n?/, '')
    // Code fences are usually too noisy for quick listening.
    .replace(/```[\s\S]*?```/g, '\n코드 블록은 생략합니다.\n')
    .replace(/~~~[\s\S]*?~~~/g, '\n코드 블록은 생략합니다.\n')
    // Headings/lists/quotes: keep text, drop Markdown markers.
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/^\s*[-*_]{3,}\s*$/gm, '\n')
    // Links/images: read labels; skip raw URLs.
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '링크')
    // Inline markup.
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    // Tables sound better as comma-separated fragments than pipes.
    .replace(/\|/g, ', ')
    // Common mixed-language terms in our docs.
    .replace(/\bTTS\b/g, '티티에스')
    .replace(/\bMD\b/g, '마크다운')
    .replace(/\bAPI\b/g, '에이피아이')
    .replace(/\bURL\b/g, '유알엘')
    .replace(/\bUI\b/g, '유아이')
    .replace(/\bUX\b/g, '유엑스')
    .replace(/\bAI\b/g, '에이아이')
    .replace(/\bGitHub\b/g, '깃허브')
    .replace(/\bgpt-4o\b/gi, '지피티 포 오')
    .replace(/\bgpt\b/gi, '지피티')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function splitSpeakableText(text: string): string[] {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return [];

  const chunks: string[] = [];
  const paragraphs = normalized.split(/\n{2,}/);
  let current = '';

  const pushCurrent = () => {
    const value = current.trim();
    if (value) chunks.push(value);
    current = '';
  };

  for (const paragraph of paragraphs) {
    const part = paragraph.trim();
    if (!part) continue;

    if (part.length > MAX_UTTERANCE_CHARS) {
      pushCurrent();
      const sentences = part.match(/[^.!?。！？…]+[.!?。！？…]*|.+$/g) ?? [part];
      for (const sentence of sentences) {
        const s = sentence.trim();
        if (!s) continue;
        if (s.length > MAX_UTTERANCE_CHARS) {
          pushCurrent();
          for (let i = 0; i < s.length; i += MAX_UTTERANCE_CHARS) {
            chunks.push(s.slice(i, i + MAX_UTTERANCE_CHARS));
          }
        } else if ((current + '\n' + s).trim().length > MAX_UTTERANCE_CHARS) {
          pushCurrent();
          current = s;
        } else {
          current = current ? `${current}\n${s}` : s;
        }
      }
      continue;
    }

    if ((current + '\n\n' + part).trim().length > MAX_UTTERANCE_CHARS) {
      pushCurrent();
    }
    current = current ? `${current}\n\n${part}` : part;
  }

  pushCurrent();
  return chunks;
}

interface Props {
  /** Raw Markdown content from the active viewer tab. */
  content: string;
  /** Optional compact className for placement in viewer headers. */
  className?: string;
}

export function MarkdownTtsControls({ content, className }: Props) {
  const [supported, setSupported] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [paused, setPaused] = useState(false);
  const activeRunRef = useRef(0);
  const lastContentRef = useRef(content);
  const playbackActiveRef = useRef(false);

  useEffect(() => {
    const hasSpeech = typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
    setSupported(hasSpeech);
    if (hasSpeech && window.speechSynthesis.paused) {
      setSpeaking(true);
      setPaused(true);
    }
    return () => {
      if (playbackActiveRef.current && typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.pause();
      }
    };
  }, []);

  const chunks = useMemo(() => splitSpeakableText(markdownToSpeakableText(content)), [content]);
  const canSpeak = supported && chunks.length > 0;

  useEffect(() => {
    playbackActiveRef.current = speaking || paused;
  }, [paused, speaking]);

  const speak = useCallback(() => {
    if (!canSpeak) return;
    const synth = window.speechSynthesis;
    const runId = activeRunRef.current + 1;
    activeRunRef.current = runId;
    synth.cancel();
    playbackActiveRef.current = true;
    setSpeaking(true);
    setPaused(false);

    const voices = synth.getVoices();
    const koreanVoice = voices.find((voice) => voice.lang?.toLowerCase().startsWith('ko'));

    chunks.forEach((chunk, index) => {
      const utterance = new SpeechSynthesisUtterance(chunk);
      utterance.lang = 'ko-KR';
      utterance.rate = 0.95;
      utterance.pitch = 1;
      utterance.volume = 1;
      if (koreanVoice) utterance.voice = koreanVoice;
      utterance.onend = () => {
        if (activeRunRef.current !== runId) return;
        if (index === chunks.length - 1) {
          playbackActiveRef.current = false;
          setSpeaking(false);
          setPaused(false);
        }
      };
      utterance.onerror = () => {
        if (activeRunRef.current !== runId) return;
        playbackActiveRef.current = false;
        setSpeaking(false);
        setPaused(false);
      };
      synth.speak(utterance);
    });
  }, [canSpeak, chunks]);

  const pause = useCallback(() => {
    if (!supported) return;
    window.speechSynthesis.pause();
    playbackActiveRef.current = true;
    setSpeaking(true);
    setPaused(true);
  }, [supported]);

  const resume = useCallback(() => {
    if (!supported) return;
    window.speechSynthesis.resume();
    playbackActiveRef.current = true;
    setPaused(false);
    setSpeaking(true);
  }, [supported]);

  const togglePlayback = useCallback(() => {
    if (paused) {
      resume();
      return;
    }
    if (speaking) {
      pause();
      return;
    }
    speak();
  }, [pause, paused, resume, speak, speaking]);

  const stop = useCallback(() => {
    if (!supported) return;
    activeRunRef.current += 1;
    window.speechSynthesis.cancel();
    playbackActiveRef.current = false;
    setSpeaking(false);
    setPaused(false);
  }, [supported]);

  useEffect(() => {
    if (lastContentRef.current === content) return;
    lastContentRef.current = content;
    if (!speaking && !paused) return;
    pause();
  }, [content, pause, paused, speaking]);

  if (!supported) {
    return (
      <button
        type="button"
        disabled
        className={className ?? 'flex h-8 w-8 items-center justify-center rounded-md border border-surface-700 text-sm text-gray-600'}
        title="이 브라우저는 무료 내장 TTS를 지원하지 않습니다"
        aria-label="이 브라우저는 무료 내장 TTS를 지원하지 않습니다"
      >
        ▶
      </button>
    );
  }

  return (
    <div className={`inline-flex shrink-0 items-center rounded-md border border-surface-600 bg-surface-800 p-0.5 ${className ?? ''}`} title="브라우저 내장 음성으로 Markdown 본문 읽기">
      <button
        type="button"
        onClick={togglePlayback}
        disabled={!canSpeak}
        className={`flex h-7 w-7 items-center justify-center rounded text-sm font-medium transition-colors ${speaking && !paused ? 'bg-primary-600/25 text-primary-300' : 'text-gray-300 hover:bg-surface-700 hover:text-white'} disabled:cursor-not-allowed disabled:text-gray-600`}
        title={paused ? '읽기 재개' : speaking ? '일시정지' : 'Markdown 본문 읽어주기'}
        aria-label={paused ? '읽기 재개' : speaking ? '일시정지' : 'Markdown 본문 읽어주기'}
      >
        {paused ? '▶' : speaking ? '⏸' : '▶'}
      </button>
      {(speaking || paused) && (
        <button
          type="button"
          onClick={stop}
          className="rounded px-2 py-0.5 text-sm whitespace-nowrap text-red-300 transition-colors hover:bg-red-500/10 hover:text-red-200"
          title="읽기 중지"
        >
          ■
        </button>
      )}
    </div>
  );
}
