import { describe, expect, it } from 'vitest';
import { discoverStaticHtmlCssEditPlan, remapHtmlElementByUniqueId } from './html-css-edit-plan.js';

function selectedRange(html: string, source: string) {
  const start = html.indexOf(source);
  return { elementStart: start, elementEnd: start + source.length, expectedSource: source };
}

describe('remapHtmlElementByUniqueId', () => {
  it('remaps a stale source reference to the current uniquely identified element', () => {
    const html = '<main><h2 id="workflow-title">사용법은 세 단계뿐입니다.</h2></main>';
    const remapped = remapHtmlElementByUniqueId({
      htmlContent: html,
      tagName: 'h2',
      expectedSource: '<h2 id="workflow-title">세 단계면 충분합니다.</h2>',
    });
    expect(remapped?.source).toBe('<h2 id="workflow-title">사용법은 세 단계뿐입니다.</h2>');
    expect(html.slice(remapped!.start, remapped!.end)).toBe(remapped!.source);
  });

  it('fails closed without a stable unique id', () => {
    expect(remapHtmlElementByUniqueId({
      htmlContent: '<p class="copy">Changed</p>',
      tagName: 'p',
      expectedSource: '<p class="copy">Original</p>',
    })).toBeNull();
  });
});

describe('discoverStaticHtmlCssEditPlan', () => {
  it('returns a single exact range when no related CSS exists', async () => {
    const source = '<button>Start</button>';
    const html = `<main>${source}</main>`;
    const plan = await discoverStaticHtmlCssEditPlan({
      htmlPath: '/workspace/project/index.html',
      htmlContent: html,
      ...selectedRange(html, source),
      readLocalFile: async () => null,
    });
    expect(plan.mode).toBe('single-range');
    expect(plan.exactTargets).toMatchObject([{ path: '/workspace/project/index.html', source, confidence: 'exact' }]);
    expect(plan.relatedTargets).toEqual([]);
  });

  it('discovers direct class rules and pseudo-state rules in linked local CSS', async () => {
    const source = '<button class="cta">Start</button>';
    const html = `<html><head><link rel="stylesheet" href="./styles.css"></head><body>${source}</body></html>`;
    const css = `.cta { background: gray; }\n.cta:hover { background: black; }\n.other { color: red; }`;
    const plan = await discoverStaticHtmlCssEditPlan({
      htmlPath: '/workspace/project/index.html',
      htmlContent: html,
      ...selectedRange(html, source),
      readLocalFile: async filePath => filePath === '/workspace/project/styles.css' ? css : null,
    });
    expect(plan.mode).toBe('multi-range');
    expect(plan.relatedTargets.map(target => target.selector)).toEqual(['.cta', '.cta:hover']);
    expect(plan.relatedTargets.map(target => css.slice(target.start, target.end))).toEqual([
      '.cta { background: gray; }',
      '.cta:hover { background: black; }',
    ]);
  });

  it('marks a selector shared by multiple elements as confirmation-required', async () => {
    const source = '<button class="cta">First</button>';
    const html = `<style>.cta { color: blue; }</style>${source}<button class="cta">Second</button>`;
    const plan = await discoverStaticHtmlCssEditPlan({
      htmlPath: '/workspace/project/index.html',
      htmlContent: html,
      ...selectedRange(html, source),
      readLocalFile: async () => null,
    });
    expect(plan.mode).toBe('confirmation-required');
    expect(plan.relatedTargets[0]).toMatchObject({ kind: 'inline-style-rule', selector: '.cta', sharedMatchCount: 2 });
    expect(plan.warnings).toContainEqual(expect.objectContaining({ code: 'shared_selector', selector: '.cta' }));
  });

  it('does not silently authorize complex selectors or variable-driven rules', async () => {
    const source = '<button class="cta">Start</button>';
    const html = `<style>.hero .cta { color: var(--action); }</style><div class="hero">${source}</div>`;
    const plan = await discoverStaticHtmlCssEditPlan({
      htmlPath: '/workspace/project/index.html',
      htmlContent: html,
      ...selectedRange(html, source),
      readLocalFile: async () => null,
    });
    expect(plan.mode).toBe('confirmation-required');
    expect(plan.warnings.map(warning => warning.code)).toEqual(expect.arrayContaining(['complex_selector', 'css_variable_impact']));
  });

  it('excludes descendant selectors whose ancestor condition does not match the selected element', async () => {
    const source = '<p class="hero-copy">Intro</p>';
    const html = `<section class="hero">${source}</section><section class="step-card"><p>Step</p></section>`;
    const css = `h1, h2, h3, p { text-wrap: balance; }\n.hero-copy { color: gray; }\n.step-card p { color: blue; }`;
    const plan = await discoverStaticHtmlCssEditPlan({
      htmlPath: '/workspace/project/index.html',
      htmlContent: `<link rel="stylesheet" href="./styles.css">${html}`,
      ...selectedRange(`<link rel="stylesheet" href="./styles.css">${html}`, source),
      readLocalFile: async () => css,
    });
    expect(plan.relatedTargets.map(target => target.selector)).toEqual(['h1, h2, h3, p', '.hero-copy']);
    expect(plan.relatedTargets.map(target => target.selector)).not.toContain('.step-card p');
  });

  it('matches a descendant selector only when the selected element has the required ancestor', async () => {
    const source = '<h2>Three steps</h2>';
    const html = `<link rel="stylesheet" href="./styles.css"><div class="section-heading">${source}</div>`;
    const css = `.section-heading h2 { font-size: 48px; }\n.other h2 { color: red; }`;
    const plan = await discoverStaticHtmlCssEditPlan({
      htmlPath: '/workspace/project/index.html',
      htmlContent: html,
      ...selectedRange(html, source),
      readLocalFile: async () => css,
    });
    expect(plan.relatedTargets.map(target => target.selector)).toEqual(['.section-heading h2']);
    expect(plan.relatedTargets.map(target => target.selector)).not.toContain('.other h2');
  });

  it('reports external stylesheets without treating them as editable targets', async () => {
    const source = '<button class="cta">Start</button>';
    const html = `<link rel="stylesheet" href="https://cdn.example.com/site.css">${source}`;
    const plan = await discoverStaticHtmlCssEditPlan({
      htmlPath: '/workspace/project/index.html',
      htmlContent: html,
      ...selectedRange(html, source),
      readLocalFile: async () => null,
    });
    expect(plan.relatedTargets).toEqual([]);
    expect(plan.warnings).toContainEqual(expect.objectContaining({ code: 'external_stylesheet_ignored' }));
  });
});
