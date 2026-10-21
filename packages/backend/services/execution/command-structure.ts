/** Lifecycle-only bounded shell analysis; never authorization or a shell interpreter. */
export type CommandStructure =
  | { kind: 'single'; argv: string[] }
  | { kind: 'compound' | 'unknown'; reason: string };

type Token = { value: string; assignment: boolean };
export function inspectCommandStructure(source: string): CommandStructure {
  const unknown = (reason: string): CommandStructure => ({ kind: 'unknown', reason });
  if (source.length > 32768) return unknown('input-limit');
  const tokens: Token[] = [];
  let word = '', active = false, quote = '', prefixQuoted = false, assignment = false;
  let redirect = false, redirects = 0, separator = false;
  const token = (): boolean => {
    if (!active) return true;
    if (redirect) { redirect = false; redirects++; }
    else tokens.push({ value: word, assignment });
    word = ''; active = false; prefixQuoted = false; assignment = false;
    return true;
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote) { quote = ''; continue; }
      if (quote === '"' && (c === '$' || c === '`' || c === '\\')) return unknown('quoted-expansion');
      word += c; continue;
    }
    if (separator && (tokens.length || redirects) && !/\s/.test(c) && c !== '#') return { kind: 'compound', reason: 'multiple-lines' };
    if (c === "'" || c === '"') { if (!assignment) prefixQuoted = true; quote = c; active = true; continue; }
    if (c === '#' && !active) { while (i < source.length && source[i] !== '\n') i++; separator = true; continue; }
    if (';|&'.includes(c)) return { kind: 'compound', reason: 'shell-operator' };
    if ('$`(){}\\*?[]'.includes(c)) return unknown('compound-or-expansion');
    if (c === '\n') { token(); if (redirect) return unknown('missing-redirection-target'); separator = true; continue; }
    if (/\s/.test(c)) { token(); continue; }
    if (separator && (tokens.length || redirects)) return { kind: 'compound', reason: 'multiple-lines' };
    separator = false;
    if (c === '<' || c === '>') {
      if (redirect) return unknown('missing-redirection-target');
      if (active && /^\d+$/.test(word) && !prefixQuoted) { word = ''; active = false; }
      else token();
      if (source[i + 1] === c) { if (c === '<') return unknown('heredoc'); i++; }
      if (['<','>','&','|'].includes(source[i + 1])) return unknown('complex-redirection');
      redirect = true; continue;
    }
    if (c === '=' && !prefixQuoted && /^[A-Za-z_][A-Za-z_0-9]*$/.test(word)) assignment = true;
    active = true; word += c;
  }
  if (quote) return unknown('unclosed-quote');
  token();
  if (redirect) return unknown('missing-redirection-target');
  while (tokens[0]?.assignment) tokens.shift();
  const argv = tokens.map(t => t.value);
  const controls = new Set(['if','then','else','fi','for','while','until','do','done','case','esac','function','!','sh','bash','zsh','eval','source','.']);
  if (!argv[0] || controls.has(argv[0].split('/').pop()!)) return unknown('empty-or-control');
  return { kind: 'single', argv };
}

/** Compatibility helper: only a single unambiguous invocation may supply hints. */
export function analyzeCommandStructure(source: string): string[][] | null {
  const structure = inspectCommandStructure(source);
  return structure.kind === 'single' ? [structure.argv] : null;
}

export function serviceHint(argv: string[]): string | undefined {
  const [raw, ...args] = argv; const cmd = raw.split('/').pop();
  if (args.some(a => ['--help','-h','--version','-V'].includes(a))) return;
  if (['uvicorn','gunicorn'].includes(cmd!)) return 'api';
  if (cmd === 'cron' || cmd === 'crond') return 'cron';
  if (cmd === 'nodemon') return 'dev';
  if (['npm','pnpm','yarn','bun'].includes(cmd!)) {
    if (args[0] === 'start') return 'server';
    if (args[0] === 'dev' || (args[0] === 'run' && args[1] === 'dev')) return 'dev';
  }
  if (cmd === 'npx' && args[0] === 'vite' && args[1] !== 'build') return 'dev';
  if (cmd === 'vite' && !['build'].includes(args[0])) return 'dev';
  if (['next','nuxt'].includes(cmd!) && args[0] === 'dev') return 'dev';
  if (cmd === 'flask' && args[0] === 'run') return 'api';
  if (cmd === 'fastapi' && ['dev','run'].includes(args[0])) return 'api';
  if (/^python(?:3(?:\.\d+)?)?$/.test(cmd!) && args[0] === '-m') {
    if (args[1] === 'http.server') return 'static';
    if (['uvicorn','gunicorn'].includes(args[1])) return 'api';
  }
  if (cmd === 'node' && /^server(?:\.[cm]?js)?$/.test(args[0] ?? '')) return 'server';
  if (cmd === 'tsx' && args[0] === 'watch') return 'dev';
  if (cmd === 'celery' && args[0] === 'worker') return 'worker';
  // Inline code and post-script arguments are data, not runtime watch flags.
  if (['node','tsx','ts-node','bun','deno'].includes(cmd!)) {
    if (args.some(a => ['-e','--eval','-p','--print','--'].includes(a))) return;
    const firstOperand = args.findIndex(a => !a.startsWith('-'));
    const flags = firstOperand < 0 ? args : args.slice(0, firstOperand);
    if (flags.some(a => a === '--watch' || /^--watch=(true|preserve)$/.test(a))) return 'watcher';
  }
  if (['tsc','pytest','jest','vitest'].includes(cmd!) && !args.includes('--') && args.some(a => a === '--watch' || a === '--watch=true')) return 'watcher';
}

export function isHeavyInvocation(argv: string[]): boolean {
  const [raw, ...args] = argv; const cmd = raw.split('/').pop();
  if (args.some(a => ['--help','-h','--version','-V'].includes(a))) return false;
  if (['npm','pnpm','yarn','bun'].includes(cmd!)) return ['install','ci','test','build'].includes(args[0]) || (args[0] === 'run' && ['build','test'].includes(args[1]));
  if (['pip','pip3'].includes(cmd!)) return args[0] === 'install';
  if (cmd === 'uv') return args[0] === 'pip' && args[1] === 'install';
  if (cmd === 'npx') return ['jest','vitest','pytest','tsc','playwright','cypress'].includes(args[0]);
  if (['next','vite'].includes(cmd!)) return args[0] === 'build';
  return ['jest','vitest','pytest','tsc','playwright','cypress'].includes(cmd!);
}

export function invocationPort(argv: string[]): number | undefined {
  const cmd = argv[0].split('/').pop();
  const args = argv.slice(1);
  let value: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') break;
    if (args[i] === '--port' || args[i] === '-p') { if (value !== undefined) return; value = args[++i]; }
    else if (args[i].startsWith('--port=')) { if (value !== undefined) return; value = args[i].slice(7); }
  }
  if (value === undefined && /^python(?:3(?:\.\d+)?)?$/.test(cmd!) && args[0] === '-m' && args[1] === 'http.server') value = args[2];
  if (!value || !/^\d+$/.test(value)) return;
  const port = Number(value);
  return port > 1023 && port < 65536 ? port : undefined;
}
