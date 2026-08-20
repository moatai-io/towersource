import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const backend = fs.readFileSync(path.resolve(import.meta.dirname, '../index.ts'), 'utf8');
const publicApi = fs.readFileSync(path.resolve(import.meta.dirname, './ai-service-public-api.ts'), 'utf8');

describe('AI Service external share preview contract', () => {
  it('serves crawler-readable metadata before the SPA fallback', () => {
    expect(backend).toContain("app.get(['/ai/:channelId', '/ai-service-chat/:channelId']");
    expect(backend).toContain('isSharePreviewCrawler');
    expect(backend).toContain('og:title');
    expect(backend).toContain('og:description');
    expect(backend).toContain('og:image');
    const crawlerRoute = backend.indexOf("app.get(['/ai/:channelId', '/ai-service-chat/:channelId']");
    const staticFallback = backend.indexOf('app.use(express.static(frontendPath,');
    expect(crawlerRoute).toBeGreaterThanOrEqual(0);
    expect(crawlerRoute).toBeLessThan(staticFallback);
  });

  it('creates a share card containing agent identity and a 1200x630 preview image', () => {
    expect(backend).toContain("app.get('/ai/:channelId/share-card.svg'");
    expect(backend).toContain('width="1200" height="630"');
    expect(backend).toContain('TOWER AI AGENT');
    expect(backend).toContain('agentFaceAssetUrl');
  });

  it('reuses public-safe deployment metadata and keeps sensitive fields filtered', () => {
    expect(backend).toContain('activeSiteMetadata');
    expect(publicApi).toContain('export async function activeSiteMetadata');
    expect(publicApi).toContain('publicString(identity.tagline || experience.tagline)');
    expect(publicApi).toContain('protectedMetadata');
    expect(publicApi).toContain('publicFace(identity.face || experience.face)');
  });
});
