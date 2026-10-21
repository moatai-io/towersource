export interface PdfCanaryObservation { source: string; pages: number[] }
export interface PdfCanaryFixture { file: string; codes: string[] }

/** Each requested page must have been reopened and its own code reported. Never
 * validate a different default page set when checking a targeted retry. */
export function verifyPdfCanaryPages(input: {
  fixtures: PdfCanaryFixture[]; pages: number[]; observations: PdfCanaryObservation[]; answer: string;
}): boolean {
  if (!input.pages.length || !input.fixtures.length) return false;
  return input.fixtures.every(f => input.pages.every(page => {
    const code = f.codes[page - 1];
    if (!code || !input.observations.some(o => o.source === f.file && o.pages.includes(page))) return false;
    // Accept common compact tables and "Page N: CODE" while requiring page/code adjacency.
    const expression = new RegExp(`(?:\\|\\s*|\\b[Pp]age\\s+)${page}(?:\\s*\\([^)]*\\))?\\s*(?:\\||:|[-–])\\s*\u0060?${code}\u0060?(?=\\s|\\||$)`);
    return expression.test(input.answer);
  }));
}
