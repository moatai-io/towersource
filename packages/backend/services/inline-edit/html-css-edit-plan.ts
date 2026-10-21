// Owns: conservative related-source discovery for static HTML + local CSS.
// Public API: discoverStaticHtmlCssEditPlan.

import path from 'node:path';
import postcss, { type AtRule, type Rule } from 'postcss';
import selectorParser, { type Selector } from 'postcss-selector-parser';
import { parse, type DefaultTreeAdapterMap } from 'parse5';

const MAX_STYLESHEETS = 12;
const MAX_CSS_BYTES = 250_000;
const MAX_TARGETS = 24;

export interface HtmlCssSourceRange {
  path: string;
  kind: 'html-element' | 'inline-style-rule' | 'stylesheet-rule';
  start: number;
  end: number;
  lineStart: number;
  lineEnd: number;
  source: string;
  selector?: string;
  confidence: 'exact' | 'related';
  sharedMatchCount?: number;
}

export interface HtmlCssPlanWarning {
  code:
    | 'external_stylesheet_ignored'
    | 'stylesheet_unavailable'
    | 'stylesheet_too_large'
    | 'shared_selector'
    | 'complex_selector'
    | 'css_variable_impact'
    | 'css_import_unsupported'
    | 'too_many_targets';
  message: string;
  path?: string;
  selector?: string;
}

export interface StaticHtmlCssEditPlan {
  mode: 'single-range' | 'multi-range' | 'confirmation-required';
  element: { tagName: string; id: string | null; classes: string[] };
  exactTargets: HtmlCssSourceRange[];
  relatedTargets: HtmlCssSourceRange[];
  warnings: HtmlCssPlanWarning[];
}

export interface RemappedHtmlElementRange {
  start: number;
  end: number;
  lineStart: number;
  lineEnd: number;
  source: string;
}

interface DiscoverInput {
  htmlPath: string;
  htmlContent: string;
  elementStart: number;
  elementEnd: number;
  expectedSource: string;
  readLocalFile: (absolutePath: string) => Promise<string | null>;
}

type DocumentNode = DefaultTreeAdapterMap['document'];
type ParentNode = DefaultTreeAdapterMap['parentNode'];
type ChildNode = DefaultTreeAdapterMap['childNode'];
type ElementNode = DefaultTreeAdapterMap['element'];

function isElement(node: ChildNode): node is ElementNode {
  return 'tagName' in node && typeof node.tagName === 'string';
}

function walk(node: DocumentNode | ParentNode, visit: (element: ElementNode) => void) {
  for (const child of node.childNodes) {
    if (!isElement(child)) continue;
    visit(child);
    walk(child, visit);
    if ('content' in child && child.content) walk(child.content, visit);
  }
}

function attr(element: ElementNode, name: string): string | null {
  return element.attrs.find((item) => item.name.toLowerCase() === name)?.value ?? null;
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (source.charCodeAt(index) === 10) line += 1;
  return line;
}

function selectedElement(document: DocumentNode, start: number, end: number): ElementNode | null {
  let found: ElementNode | null = null;
  walk(document, (element) => {
    const location = element.sourceCodeLocation;
    if (location?.startOffset === start && location.endOffset === end) found = element;
  });
  return found;
}

export function remapHtmlElementByUniqueId(input: {
  htmlContent: string;
  tagName: string;
  expectedSource: string;
}): RemappedHtmlElementRange | null {
  const id = input.expectedSource.match(/\bid\s*=\s*(["'])([^"']+)\1/i)?.[2];
  if (!id) return null;
  const document = parse(input.htmlContent, { sourceCodeLocationInfo: true });
  const matches: ElementNode[] = [];
  walk(document, (element) => {
    if (element.tagName.toLowerCase() === input.tagName.toLowerCase() && attr(element, 'id') === id && element.sourceCodeLocation) {
      matches.push(element);
    }
  });
  if (matches.length !== 1) return null;
  const location = matches[0].sourceCodeLocation!;
  return {
    start: location.startOffset,
    end: location.endOffset,
    lineStart: location.startLine,
    lineEnd: location.endLine,
    source: input.htmlContent.slice(location.startOffset, location.endOffset),
  };
}

function elementIdentity(element: ElementNode) {
  return {
    tagName: element.tagName.toLowerCase(),
    id: attr(element, 'id'),
    classes: (attr(element, 'class') || '').split(/\s+/).filter(Boolean),
  };
}

function elementAncestors(element: ElementNode): ElementNode[] {
  const ancestors: ElementNode[] = [];
  let current: any = element.parentNode ?? null;
  while (current) {
    if (isElement(current as ChildNode)) ancestors.push(current as ElementNode);
    current = current.parentNode ?? null;
  }
  return ancestors;
}

function compoundMatches(nodes: any[], identity: ReturnType<typeof elementIdentity>): boolean {
  let hasIdentity = false;
  for (const node of nodes) {
    if (node.type === 'tag') {
      hasIdentity = true;
      if (node.value.toLowerCase() !== identity.tagName && node.value !== '*') return false;
    } else if (node.type === 'id') {
      hasIdentity = true;
      if (!identity.id || node.value !== identity.id) return false;
    } else if (node.type === 'class') {
      hasIdentity = true;
      if (!identity.classes.includes(node.value)) return false;
    } else if (node.type === 'attribute' || node.type === 'nesting') {
      return false;
    }
  }
  return hasIdentity;
}

function selectorShape(selectorText: string, element: ElementNode): {
  matches: boolean;
  direct: boolean;
  pseudoState: boolean;
  usesVariableLikeRoot: boolean;
} {
  let matches = false;
  let direct = true;
  let pseudoState = false;
  let usesVariableLikeRoot = false;
  try {
    selectorParser((root) => {
      root.each((selectorNode) => {
        const selector = selectorNode as Selector;
        const nodes = Array.from(selector.nodes);
        const combinatorIndexes = nodes.flatMap((node, index) => node.type === 'combinator' ? [index] : []);
        if (combinatorIndexes.length > 0) direct = false;
        for (const node of nodes) {
          if (node.type === 'pseudo') {
            if (node.value === ':root') usesVariableLikeRoot = true;
            else if (node.value !== ':where' && node.value !== ':is') pseudoState = true;
          } else if (node.type === 'attribute' || node.type === 'nesting') {
            direct = false;
          }
        }

        const compounds: any[][] = [];
        const combinators: string[] = [];
        let compound: any[] = [];
        for (const node of nodes) {
          if (node.type === 'combinator') {
            compounds.push(compound);
            compound = [];
            combinators.push(node.value.trim() || ' ');
          } else {
            compound.push(node);
          }
        }
        compounds.push(compound);
        if (!compoundMatches(compounds.at(-1) || [], elementIdentity(element))) return;

        const ancestors = elementAncestors(element);
        let ancestorIndex = 0;
        let branchMatches = true;
        for (let index = compounds.length - 2; index >= 0; index -= 1) {
          const combinator = combinators[index];
          if (combinator === '>') {
            const ancestor = ancestors[ancestorIndex];
            if (!ancestor || !compoundMatches(compounds[index], elementIdentity(ancestor))) {
              branchMatches = false;
              break;
            }
            ancestorIndex += 1;
          } else if (combinator === ' ') {
            let found = false;
            while (ancestorIndex < ancestors.length) {
              const ancestor = ancestors[ancestorIndex++];
              if (compoundMatches(compounds[index], elementIdentity(ancestor))) {
                found = true;
                break;
              }
            }
            if (!found) {
              branchMatches = false;
              break;
            }
          } else {
            branchMatches = false;
            break;
          }
        }
        if (branchMatches) matches = true;
      });
    }).processSync(selectorText);
  } catch {
    direct = false;
  }
  return { matches, direct, pseudoState, usesVariableLikeRoot };
}

function countSimpleMatches(document: DocumentNode, selectorText: string): number | null {
  let hasComplexSelector = false;
  let count = 0;
  walk(document, (element) => {
    const shape = selectorShape(selectorText, element);
    if (!shape.direct) hasComplexSelector = true;
    if (shape.matches) count += 1;
  });
  return hasComplexSelector ? null : count;
}

function pushCssRules(args: {
  css: string;
  cssPath: string;
  offsetBase: number;
  document: DocumentNode;
  identity: ReturnType<typeof elementIdentity>;
  selectedElement: ElementNode;
  kind: HtmlCssSourceRange['kind'];
  lineBase: number;
  relatedTargets: HtmlCssSourceRange[];
  warnings: HtmlCssPlanWarning[];
}) {
  let root;
  try {
    root = postcss.parse(args.css, { from: args.cssPath });
  } catch {
    args.warnings.push({ code: 'stylesheet_unavailable', message: 'The stylesheet could not be parsed safely.', path: args.cssPath });
    return;
  }
  root.walkAtRules('import', (rule: AtRule) => {
    args.warnings.push({ code: 'css_import_unsupported', message: '@import dependencies require confirmation.', path: args.cssPath, selector: rule.params });
  });
  root.walkRules((rule: Rule) => {
    if (rule.source?.start?.offset === undefined || rule.source.end?.offset === undefined) return;
    const shape = selectorShape(rule.selector, args.selectedElement);
    if (!shape.matches) return;
    const start = args.offsetBase + rule.source.start.offset;
    const end = args.offsetBase + rule.source.end.offset;
    const source = args.css.slice(rule.source.start.offset, rule.source.end.offset);
    const sharedMatchCount = countSimpleMatches(args.document, rule.selector);
    const hasVariable = /var\s*\(|--[\w-]+\s*:/.test(source) || shape.usesVariableLikeRoot;
    if (!shape.direct) {
      args.warnings.push({ code: 'complex_selector', message: 'A related selector depends on ancestry, attributes, or unsupported selector semantics.', path: args.cssPath, selector: rule.selector });
    }
    if (sharedMatchCount === null || sharedMatchCount > 1) {
      args.warnings.push({ code: 'shared_selector', message: `The selector may affect ${sharedMatchCount ?? 'multiple'} elements.`, path: args.cssPath, selector: rule.selector });
    }
    if (hasVariable) {
      args.warnings.push({ code: 'css_variable_impact', message: 'The rule uses or defines CSS variables whose impact may extend beyond the selected element.', path: args.cssPath, selector: rule.selector });
    }
    args.relatedTargets.push({
      path: args.cssPath,
      kind: args.kind,
      start,
      end,
      lineStart: args.lineBase + lineAt(args.css, rule.source.start.offset),
      lineEnd: args.lineBase + lineAt(args.css, Math.max(rule.source.start.offset, rule.source.end.offset - 1)),
      source,
      selector: rule.selector,
      confidence: 'related',
      sharedMatchCount: sharedMatchCount ?? undefined,
    });
  });
}

export async function discoverStaticHtmlCssEditPlan(input: DiscoverInput): Promise<StaticHtmlCssEditPlan> {
  if (input.htmlContent.slice(input.elementStart, input.elementEnd) !== input.expectedSource) {
    throw new Error('scoped_edit_selection_stale');
  }
  const document = parse(input.htmlContent, { sourceCodeLocationInfo: true });
  const element = selectedElement(document, input.elementStart, input.elementEnd);
  if (!element) throw new Error('scoped_edit_element_mapping_missing');
  const identity = elementIdentity(element);
  const warnings: HtmlCssPlanWarning[] = [];
  const relatedTargets: HtmlCssSourceRange[] = [];
  const exactTargets: HtmlCssSourceRange[] = [{
    path: input.htmlPath,
    kind: 'html-element',
    start: input.elementStart,
    end: input.elementEnd,
    lineStart: element.sourceCodeLocation!.startLine,
    lineEnd: element.sourceCodeLocation!.endLine,
    source: input.expectedSource,
    confidence: 'exact',
  }];

  const stylesheetPaths: string[] = [];
  walk(document, (candidate) => {
    if (candidate.tagName === 'style' && candidate.sourceCodeLocation?.startTag && candidate.sourceCodeLocation.endTag) {
      const start = candidate.sourceCodeLocation.startTag.endOffset;
      const end = candidate.sourceCodeLocation.endTag.startOffset;
      pushCssRules({ css: input.htmlContent.slice(start, end), cssPath: input.htmlPath, offsetBase: start, lineBase: lineAt(input.htmlContent, start) - 1, document, identity, selectedElement: element, kind: 'inline-style-rule', relatedTargets, warnings });
    }
    if (candidate.tagName !== 'link' || (attr(candidate, 'rel') || '').toLowerCase() !== 'stylesheet') return;
    const href = attr(candidate, 'href') || '';
    if (!href || /^(?:https?:|\/\/|data:)/i.test(href)) {
      warnings.push({ code: 'external_stylesheet_ignored', message: 'External stylesheets cannot receive local scoped edits.', path: href || undefined });
      return;
    }
    const resolved = path.resolve(path.dirname(input.htmlPath), href.split(/[?#]/, 1)[0]);
    if (!stylesheetPaths.includes(resolved)) stylesheetPaths.push(resolved);
  });

  for (const cssPath of stylesheetPaths.slice(0, MAX_STYLESHEETS)) {
    const css = await input.readLocalFile(cssPath);
    if (css === null) {
      warnings.push({ code: 'stylesheet_unavailable', message: 'A linked stylesheet could not be read.', path: cssPath });
      continue;
    }
    if (css.length > MAX_CSS_BYTES) {
      warnings.push({ code: 'stylesheet_too_large', message: 'A linked stylesheet exceeds the safe analysis limit.', path: cssPath });
      continue;
    }
    pushCssRules({ css, cssPath, offsetBase: 0, lineBase: 0, document, identity, selectedElement: element, kind: 'stylesheet-rule', relatedTargets, warnings });
  }

  if (stylesheetPaths.length > MAX_STYLESHEETS || relatedTargets.length > MAX_TARGETS) {
    warnings.push({ code: 'too_many_targets', message: 'The element has more related style sources than can be safely scoped automatically.' });
  }
  const boundedRelated = relatedTargets.slice(0, MAX_TARGETS);
  const requiresConfirmation = warnings.some((warning) => ['shared_selector', 'complex_selector', 'css_variable_impact', 'css_import_unsupported', 'too_many_targets'].includes(warning.code));
  return {
    mode: requiresConfirmation ? 'confirmation-required' : boundedRelated.length ? 'multi-range' : 'single-range',
    element: identity,
    exactTargets,
    relatedTargets: boundedRelated,
    warnings,
  };
}
