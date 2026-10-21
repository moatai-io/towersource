// Shared admission/projection policy. Counts are image blocks, not PDF pages.
function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
export function configuredPiImageLimit(): number {
  return positiveInteger('PI_RESPONSES_MAX_INLINE_FILE_IMAGES', 50);
}
export function configuredPiImageByteLimit(): number {
  return positiveInteger('PI_RESPONSES_MAX_INLINE_FILE_IMAGE_BYTES', 48 * 1024 * 1024);
}
export function configuredPdfRecentPages(): number {
  return positiveInteger('PI_PDF_RECENT_IMAGE_PAGES', 8);
}
