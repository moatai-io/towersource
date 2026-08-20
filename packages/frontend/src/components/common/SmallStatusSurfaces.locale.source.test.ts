import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => fs.readFileSync(path.resolve(__dirname, relative), 'utf8');
const update = read('UpdateBanner.tsx');
const retired = read('../rooms/RetiredChannelNotice.tsx');
const shortLink = read('../files/ShortFileLinkRedirect.tsx');
const pins = read('../pinboard/PinList.tsx');
const resize = read('../chat/InputResizeHandle.tsx');

describe('small status surfaces locale contract', () => {
  it('routes update and retired-channel states through locale keys', () => {
    expect(update).toContain('updateBanner.updateAfterTurn');
    expect(update).toContain('updateBanner.cancelDeferred');
    expect(retired).toContain('retiredChannel.description');
    expect(retired).toContain('retiredChannel.openAiTeam');
  });

  it('routes short-link, favorites, and input resize chrome through locale keys', () => {
    expect(shortLink).toContain('shortLink.openFailed');
    expect(shortLink).toContain('shortLink.opening');
    expect(pins).toContain('pins.emptyHint');
    expect(pins).toContain('pins.remove');
    expect(resize).toContain('inputResize.manualHint');
    expect(resize).toContain('inputResize.label');
  });

  it('preserves update callbacks, navigation, file-link resolution, and pin persistence', () => {
    expect(update).toContain('onDeferReload');
    expect(retired).toContain("setActiveView('work')");
    expect(shortLink).toContain('fetch(`/api/file-links/${encodeURIComponent(shortId)}`');
    expect(shortLink).toContain('window.location.replace(`/file-viewer?path=');
    expect(pins).toContain("localStorage.setItem('tower:files-pins-collapsed'");
  });
});
