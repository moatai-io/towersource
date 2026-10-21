import ts from 'typescript';

/** Inspect real calls, not comments/strings; reject overrides after the root field. */
export function inspectPiWrapperContexts(source) {
  const ast = ts.createSourceFile('assembly.ts', source, ts.ScriptTarget.Latest, true);
  const calls = [];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'wrapPiTools') calls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const identifier = (node, name) => node && ts.isIdentifier(node) && node.text === name;
  const key = node => node && (ts.isIdentifier(node) || ts.isStringLiteral(node)) ? node.text : null;
  const valid = call => {
    const options = call.arguments[2];
    if (!identifier(call.arguments[1], 'guard') || !options || !ts.isObjectLiteralExpression(options)) return false;
    let root = false;
    for (const p of options.properties) {
      // Spreads/computed keys could overwrite projectRoot, even through an alias.
      if (ts.isSpreadAssignment(p) || (p.name && ts.isComputedPropertyName(p.name))) return false;
      if (key(p.name) === 'projectRoot') {
        if (root || !ts.isPropertyAssignment(p) || !identifier(p.initializer, 'sessionProjectRoot')) return false;
        root = true;
      }
    }
    return root;
  };
  const builtins = calls.filter(c => identifier(c.arguments[0], 'piTools'));
  const custom = calls.filter(c => {
    const arg = c.arguments[0];
    if (!arg || !ts.isArrayLiteralExpression(arg)) return false;
    return ['piTools', 'customTools', 'mcpTools'].every(name => arg.elements.some(e => ts.isSpreadElement(e) && identifier(e.expression, name)));
  });
  return { builtins: builtins.length > 0 && builtins.every(valid), custom: custom.length > 0 && custom.every(valid), all: calls.every(valid) };
}
