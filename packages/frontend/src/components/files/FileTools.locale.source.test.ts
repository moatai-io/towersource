import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const cad = fs.readFileSync(path.resolve(__dirname, 'CadPreview.tsx'), 'utf8');
const tts = fs.readFileSync(path.resolve(__dirname, 'MarkdownTtsControls.tsx'), 'utf8');
const editor = fs.readFileSync(path.resolve(__dirname, 'markdown-editor/MarkdownEditor.tsx'), 'utf8');

describe('file tool locale contracts', () => {
  it('routes CAD render, analysis, search, and artifact UI through files locale keys', () => {
    for (const key of ['cad.render.preparing', 'cad.tabs.analysis', 'cad.textSearch', 'cad.analysisReadiness', 'cad.artifactDescription']) {
      expect(cad).toContain(key);
    }
    expect(cad).toContain("requestAiForCurrentSelection('선택한 CAD 객체/영역을 설명해줘')");
  });

  it('keeps Korean speech normalization while localizing TTS controls', () => {
    expect(tts).toContain("'\\n코드 블록은 생략합니다.\\n'");
    for (const key of ['markdownTts.unsupported', 'markdownTts.read', 'markdownTts.stop']) expect(tts).toContain(key);
  });

  it('localizes editor actions and inserted default copy', () => {
    for (const key of ['markdownEditor.defaultHeading', 'markdownEditor.fileInserted', 'markdownEditor.boldToggle', 'markdownEditor.hint']) {
      expect(editor).toContain(key);
    }
  });
});
