import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const DEPLOY_ENGINE_PATH = path.resolve(import.meta.dirname, '../deploy-engine.ts');
const API_ROUTE_PATH = path.resolve(import.meta.dirname, '../../../routes/api.ts');
const PROJECT_DISPLAY_PATH = path.resolve(import.meta.dirname, '../../publishing/project-display.ts');

function readSource(file = DEPLOY_ENGINE_PATH): string {
  return fs.readFileSync(file, 'utf-8');
}

describe('deploy-engine — local publishing source contracts', () => {
  it('uses slug, not logical name, as the local static folder identity', () => {
    const src = readSource();
    expect(src).toMatch(/const slug = await atDeployStage\('prepare', \(\) => resolveDeploySlug/);
    expect(src).toMatch(/atDeployStage\('copy', \(\) => publishStaticLocally\(\{ \.\.\.opts, slug, access \}, slug\)/);
    expect(src).toMatch(/url: localPublishedUrl\(slug\)/);
    expect(src).toMatch(/checkSiteExists\(s\.slug \|\| s\.name\)/);
  });

  it('delegates local publishing URL to explicit path mode or legacy subdomain generator', () => {
    const src = readSource();
    expect(src).toContain('publishedSiteUrl(slug, config.publicUrl, config.publishingBaseUrl)');
    expect(src).toMatch(/const slug = s\.slug \|\| s\.name/);
    expect(src).toContain('if (!config.publishingBaseUrl || !s.external_url)');
    expect(src).not.toMatch(/return `\$\{u\.protocol\}\/\/\$\{u\.host\}\/sites\/\$\{slug\}\//);
  });

  it('prevents duplicate synthetic Hub rows for slug-named disk folders', () => {
    const src = readSource();
    expect(src).toMatch(/new Set\(manifest\.sites\.flatMap\(s => \[s\.name, s\.slug \|\| s\.name\]\)\)/);
  });

  it('filters member Hub rows by manifest project folder keys, not DB UUIDs', () => {
    const api = readSource(API_ROUTE_PATH);
    const projectDisplay = readSource(PROJECT_DISPLAY_PATH);
    expect(projectDisplay).toMatch(/export async function loadProjectFolderKeyMap/);
    expect(api).toMatch(/loadProjectFolderKeyMap/);
    expect(api).toMatch(/membershipProjectIds\.map\(\(id\) => folderById\[id\] \|\| id\)/);
    expect(api).toMatch(/allowed\.has\(site\.project\)/);
  });

  it('generates Publishing Hub thumbnails from the published page path', () => {
    const src = readSource();
    expect(src).toMatch(/generatePublishThumbnailInBackground/);
    expect(src).toMatch(/thumbnail_status:\s*'pending'/);
    expect(src).toMatch(/thumbnail_url:\s*thumbnailUrlForSlug/);
    expect(src).toMatch(/updateManifestThumbnail/);
  });

  it('keeps site slugs longer than Azure app names so unlisted suffixes survive', () => {
    const src = readSource();
    expect(src).toMatch(/function normalizeSiteSlug/);
    expect(src).toMatch(/normalizeSiteSlug\(baseName, access === 'unlisted' \? 56 : 63\)/);
    expect(src).toMatch(/if \(result\.target === 'local' && result\.slug\) existing\.slug = result\.slug/);
    expect(src).toMatch(/buildDeploySlug\(opts\.name, access, undefined, manifest, opts\.slug, 'app'\)/);
  });
});
