// Owns: view-only Prettier formatting for text/code files. Public API: formatCodeForPreview.

const PRETTIER_PARSERS: Record<string, string> = {
  javascript: 'babel',
  jsx: 'babel',
  typescript: 'typescript',
  tsx: 'typescript',
  json: 'json',
  css: 'css',
  html: 'html',
  yaml: 'yaml',
  markdown: 'markdown',
};

/** Returns display-only formatted code, falling back to the exact source on unsupported or invalid input. */
export async function formatCodeForPreview(content: string, language: string): Promise<string> {
  const parser = PRETTIER_PARSERS[language];
  if (!parser || !content.trim()) return content;

  try {
    if (language === 'json') return `${JSON.stringify(JSON.parse(content), null, 2)}\n`;

    const [prettier, babel, estree, typescript, postcss, html, yaml, markdown] = await Promise.all([
      import('prettier/standalone'),
      import('prettier/plugins/babel'),
      import('prettier/plugins/estree'),
      import('prettier/plugins/typescript'),
      import('prettier/plugins/postcss'),
      import('prettier/plugins/html'),
      import('prettier/plugins/yaml'),
      import('prettier/plugins/markdown'),
    ]);

    return await prettier.format(content, {
      parser,
      plugins: [babel, estree, typescript, postcss, html, yaml, markdown],
      tabWidth: 2,
      useTabs: false,
    });
  } catch {
    return content;
  }
}
