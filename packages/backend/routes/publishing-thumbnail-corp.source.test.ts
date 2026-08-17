import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const backend = fs.readFileSync(path.resolve(import.meta.dirname, '../index.ts'), 'utf8');
const deployEngine = fs.readFileSync(path.resolve(import.meta.dirname, '../services/deploy/deploy-engine.ts'), 'utf8');
const panel = fs.readFileSync(path.resolve(import.meta.dirname, '../../frontend/src/components/publish/PublishPanel.tsx'), 'utf8');

describe('Publishing Hub cross-origin thumbnail contract', () => {
  it('allows canonical thumbnails to render from desk-dev and customer origins', () => {
    expect(backend).toContain("app.use('/published-thumbnails', express.static");
    expect(backend).toContain("res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')");
    expect(panel).toContain('src={site.thumbnail_url}');
  });

  it('normalizes local and legacy thumbnail URLs to each VM public origin', () => {
    expect(deployEngine).toContain("if (!s.deploy_target || s.deploy_target === 'local')");
    expect(deployEngine).toContain('s.thumbnail_url = thumbnailUrlForSlug(slug)');
    expect(deployEngine).toContain('s.external_url = localPublishedUrl(slug)');
  });
});
