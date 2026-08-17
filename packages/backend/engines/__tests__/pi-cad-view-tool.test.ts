import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCadViewTool, renderCadToCachedImage } from '../pi-cad-view-tool.js';

const tempDirs: string[] = [];
const originalCadPython = process.env.TOWER_CAD_PYTHON;

beforeEach(() => {
  process.env.TOWER_CAD_PYTHON = '/usr/bin/python3';
});

async function makeTempDir(prefix: string) {
  const workspaceBase = path.join(os.homedir(), 'workspace', 'projects', 'tower', 'experiments');
  await fs.mkdir(workspaceBase, { recursive: true });
  const dir = await fs.mkdtemp(path.join(workspaceBase, prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  if (originalCadPython == null) delete process.env.TOWER_CAD_PYTHON;
  else process.env.TOWER_CAD_PYTHON = originalCadPython;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function writeTinyDxf(cwd: string) {
  const dxfPath = path.join(cwd, 'tiny.dxf');
  await fs.writeFile(dxfPath, `0
SECTION
2
HEADER
9
$ACADVER
1
AC1015
0
ENDSEC
0
SECTION
2
ENTITIES
0
LINE
8
0
10
0
20
0
30
0
11
100
21
0
31
0
0
LINE
8
0
10
100
20
0
30
0
11
100
21
60
31
0
0
LINE
8
0
10
100
20
60
30
0
11
0
21
60
31
0
0
LINE
8
0
10
0
20
60
30
0
11
0
21
0
31
0
0
TEXT
8
0
10
10
20
25
30
0
40
8
1
CAD VIEW
0
ENDSEC
0
EOF
`, 'utf8');
  return dxfPath;
}

describe('cad_view', () => {
  it('renders DXF drawings to internal cached PNG images', async () => {
    const cwd = await makeTempDir('tower-cad-view-test-');
    const dxfPath = await writeTinyDxf(cwd);

    const rendered = await renderCadToCachedImage({ cwd, path: dxfPath, width: 1200, height: 900 });

    expect(rendered.cadPath).toBe(dxfPath);
    expect(rendered.cacheDir).toContain(path.join('.cache', 'tower', 'cad-view'));
    expect(rendered.image.path).toContain(rendered.cacheDir);
    expect(rendered.image.path).not.toContain(cwd);
    const stat = await fs.stat(rendered.image.path);
    expect(stat.size).toBeGreaterThan(1000);
    const manifest = JSON.parse(await fs.readFile(path.join(rendered.cacheDir, 'manifest.json'), 'utf8'));
    expect(manifest.monochrome).toBe(false);

    const second = await renderCadToCachedImage({ cwd, path: dxfPath, width: 1200, height: 900 });
    expect(second.cacheDir).toBe(rendered.cacheDir);
    expect(second.cacheHit).toBe(true);
  }, 30000);

  it('exposes cad_view as a vision-returning Pi tool', async () => {
    const cwd = await makeTempDir('tower-cad-view-tool-test-');
    const dxfPath = await writeTinyDxf(cwd);
    const tool = createCadViewTool({ cwd, sessionId: 'test-session' });

    const result = await tool.execute('tool-call', { path: dxfPath, width: 1200, height: 900 });

    expect(result.isError).not.toBe(true);
    expect(result.details.cadViewed).toBe(true);
    expect(result.content.some((block: any) => block.type === 'image')).toBe(true);
    expect(result.content.map((block: any) => block.text || '').join('\n')).toContain('Viewed CAD drawing with vision');
  }, 30000);
});
