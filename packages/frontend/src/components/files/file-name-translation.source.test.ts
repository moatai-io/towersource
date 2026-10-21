import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Inspect JSX rather than class ordering: protect identifiers, not surrounding UI.
function protectedExpressions(file: string): Set<string> {
  const source = ts.createSourceFile(file, fs.readFileSync(path.resolve(import.meta.dirname, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const expressions = new Set<string>();
  function visit(node: ts.Node, protectedByParent = false) {
    let protectedHere = protectedByParent;
    if (ts.isJsxElement(node)) {
      const attrs = node.openingElement.attributes.properties;
      protectedHere ||= attrs.some(a => ts.isJsxAttribute(a) && a.name.getText(source) === 'translate' && a.initializer && ts.isStringLiteral(a.initializer) && a.initializer.text === 'no');
    }
    if (protectedHere && ts.isJsxExpression(node) && node.expression) expressions.add(node.expression.getText(source));
    ts.forEachChild(node, child => visit(child, protectedHere));
  }
  visit(source);
  return expressions;
}

describe('file identifier browser translation protection', () => {
  it('protects both sidebar and context-menu file names', () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, 'FileTree.tsx'), 'utf8');
    expect(protectedExpressions('FileTree.tsx').has('entry.name')).toBe(true);
    expect(source.match(/translate="no"/g)).toHaveLength(2);
  });

  it('protects workspace names, breadcrumbs and path displays without disabling UI localization', () => {
    const expressions = protectedExpressions('FilesWorkspace.tsx');
    for (const expression of ['entry.name', 'crumb.label', 'currentPath', 'relativePath(currentPath, rootPath)', 'relativePath(inlineCreateTargetPath || currentPath, rootPath)']) {
      expect(expressions.has(expression), expression).toBe(true);
    }
    expect(expressions.has("t('workspace.newFolder')")).toBe(false);
    expect(expressions.has("t('workspace.parentFolder')")).toBe(false);
  });
});
