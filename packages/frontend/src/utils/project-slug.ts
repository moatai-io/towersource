/**
 * Project folder slug helpers shared by project create forms.
 * Keep this in sync with backend `PROJECT_SLUG_RE` in project-manager.ts.
 */
export const PROJECT_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

export function normalizeProjectSlugInput(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 80);
}

export function deriveProjectSlugFromName(name: string): string {
  return normalizeProjectSlugInput(
    name
      .normalize('NFKD')
      .replace(/&/g, ' and ')
      .replace(/[^a-zA-Z0-9]+/g, '-'),
  ).replace(/-+$/g, '');
}

export function isValidProjectSlug(slug: string): boolean {
  return PROJECT_SLUG_PATTERN.test(slug);
}
