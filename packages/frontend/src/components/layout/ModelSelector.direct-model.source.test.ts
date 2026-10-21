import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const selector = fs.readFileSync(path.resolve(import.meta.dirname, 'ModelSelector.tsx'), 'utf8');
const mobile = fs.readFileSync(path.resolve(import.meta.dirname, 'Header.tsx'), 'utf8');
const inputBox = fs.readFileSync(path.resolve(import.meta.dirname, '../chat/InputBox.tsx'), 'utf8');
const statusLine = fs.readFileSync(path.resolve(import.meta.dirname, '../chat/StatusLine.tsx'), 'utf8');
const chatPanel = fs.readFileSync(path.resolve(import.meta.dirname, '../chat/ChatPanel.tsx'), 'utf8');
const display = fs.readFileSync(path.resolve(import.meta.dirname, 'model-display.ts'), 'utf8');
const priceLine = fs.readFileSync(path.resolve(import.meta.dirname, 'ModelTokenPrice.tsx'), 'utf8');

describe('direct LiteLLM model selection', () => {
  it('pins Core and Lite above the remaining VM registry without policy/direct reinterpretation', () => {
    expect(selector).toContain('defaultPiModels.map(renderModel)');
    expect(selector).toContain('registryPiModels.map(renderModel)');
    expect(selector).toContain("t('defaultModels')");
    expect(selector).not.toContain("model.kind !== 'direct'");
    expect(selector).not.toContain("model.kind === 'direct'");
    expect(selector).not.toContain("t('automaticModelSelection')");
    expect(selector).not.toContain("t('directModelSelection')");
  });

  it('uses the same default-first registry structure in the mobile menu', () => {
    expect(mobile).toContain('defaultPiModels.map((model) =>');
    expect(mobile).toContain('registryPiModels.map((model) =>');
    expect(mobile).toContain("t('defaultModels')");
    expect(mobile).toContain('<ModelTokenPrice model={model} />');
    expect(mobile).not.toContain("model.kind !== 'direct'");
    expect(mobile).not.toContain("model.kind === 'direct'");
    expect(mobile).not.toContain("t('directModelSelection')");
  });

  it('renders model and context, but not cost, in a separate status line below the composer', () => {
    expect(inputBox).not.toContain('<ModelSelector');
    expect(chatPanel).toContain('<StatusLine isTurnActive={showLiveTurnFooter} />');
    expect(statusLine).toContain('role="progressbar"');
    expect(statusLine).toContain('style={{ width: `${context.pressurePct ?? context.contextPct}%` }}');
    expect(statusLine).not.toContain("t('lastTurnCost'");
    expect(statusLine).toContain('<ModelSelector dropdownAlign="up" variant="composer"');
    expect(chatPanel).toContain('relative z-20 mx-auto');
    expect(chatPanel).toContain('overflow-visible');
    expect(chatPanel).not.toContain('relative z-40 mx-auto');
    expect(selector).toContain("variant?: 'header' | 'composer'");
    expect(selector).toContain("t('modelPickerDescription')");
    expect(selector).toContain("createPortal(");
    expect(selector).toContain('className="fixed z-[40]');
    expect(selector).toContain('menuRef.current?.contains(e.target as Node)');
    expect(selector).toContain('<ModelTokenPrice model={model} />');
    expect(priceLine).toContain('getModelPriceLabel(model)');
    expect(priceLine).toContain("t('modelPriceUnit')");
  });

  it('does not trust LiteLLM transport ownership as the model maker', () => {
    expect(display).toContain("return 'Z.ai'");
    expect(display).toContain("return 'DeepSeek'");
    expect(display).not.toContain('model.provider');
  });
});
