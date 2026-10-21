import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const cad = fs.readFileSync(path.resolve(__dirname, 'CadPreview.tsx'), 'utf8');
const tts = fs.readFileSync(path.resolve(__dirname, 'MarkdownTtsControls.tsx'), 'utf8');
const editor = fs.readFileSync(path.resolve(__dirname, 'markdown-editor/MarkdownEditor.tsx'), 'utf8');

describe('file tool locale contracts', () => {
  it('routes the retained basic CAD preview through files locale keys', () => {
    for (const key of ['cad.render.preparing', 'cad.fileSize', 'cad.bounds', 'cad.layers', 'cad.views', 'cad.entityTypes']) {
      expect(cad).toContain(key);
    }
    expect(cad).not.toContain('requestAiForCurrentSelection');
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
