/**
 * pi-cad-view-tool.ts — harness-level CAD visual reader for Pi.
 *
 * Owns: cad_view, a Tower/Pi harness tool that renders CAD drawings into an
 * internal cache and returns inline image content for LLM vision. DXF is
 * supported through the fleet-baseline Python ezdxf renderer. DWG and higher
 * fidelity rendering can use a globally installed QCAD/ODA-style renderer when
 * present, but project-vendored renderers are intentionally not required.
 *
 * Public API:
 *   - createCadViewTool(ctx)
 *   - renderCadToCachedImage(args)
 */

import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentToolResult } from '@earendil-works/pi-coding-agent';
import { prepareFileRepresentation, withPreparedLocalFile } from '../services/content-safety/file-representation-gateway.js';
import { applyModelOutputBudget } from '../services/content-safety/model-output-budget-gateway.js';

export interface CadViewContext {
  cwd: string;
  sessionId: string;
  userId?: number;
  projectRoot?: string;
}

export interface CadBBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface CadViewCandidate {
  id: string;
  label: string;
  kind: 'overview' | 'layout' | 'view' | 'title-block' | 'table' | 'detail';
  bbox: CadBBox;
  entityCount: number;
  score: number;
}

export interface CadMetadataResult {
  cadPath: string;
  fileSize: number;
  layouts: Array<{ name: string; entityCount: number }>;
  layers: Array<{ name: string; entityCount: number; color?: number }>;
  entityTypes: Record<string, number>;
  overallBBox?: CadBBox;
  candidates: CadViewCandidate[];
  notes: string[];
}

export interface RenderCadArgs {
  cwd: string;
  path: string;
  width?: number;
  height?: number;
  background?: 'white' | 'black' | 'transparent';
  monochrome?: boolean;
  bbox?: CadBBox;
}

export interface RenderCadResult {
  cadPath: string;
  renderer: 'ezdxf' | 'qcad';
  cacheDir: string;
  cacheHit: boolean;
  image: { path: string; mimeType: 'image/png'; width: number; height: number };
  notes: string[];
}

const DEFAULT_WIDTH = 2400;
const DEFAULT_HEIGHT = 1800;
const CAD_RENDER_VERSION = 11;
const CACHE_ROOT = process.env.TOWER_CAD_VIEW_CACHE_DIR || path.join(os.homedir(), '.cache', 'tower', 'cad-view');
const SUPPORTED_EXTENSIONS = new Set(['.dxf', '.dwg']);

export type CadRenderMode = 'in-process' | 'worker';

export function isCadRenderEnabled(): boolean {
  const raw = process.env.TOWER_CAD_RENDER_ENABLED;
  if (raw == null || raw === '') return true; // Preserve existing full-VM behavior unless explicitly disabled.
  return !['0', 'false', 'no', 'off', 'disabled'].includes(raw.toLowerCase());
}

export function getCadRenderMode(): CadRenderMode {
  return process.env.TOWER_CAD_RENDER_MODE === 'worker' || process.env.TOWER_CAD_RENDER_WORKER_ENABLED === 'true'
    ? 'worker'
    : 'in-process';
}

function assertCadRenderEnabled(): void {
  if (!isCadRenderEnabled()) {
    throw new Error('CAD preview is not enabled on this Tower instance. Set TOWER_CAD_RENDER_ENABLED=true to enable the optional CAD render module.');
  }
}

interface PreparedCadRender {
  cadPath: string;
  renderer: 'ezdxf' | 'qcad';
  cacheDir: string;
  outputPath: string;
  cacheHit: boolean;
  image: { path: string; mimeType: 'image/png'; width: number; height: number };
  width: number;
  height: number;
  background: 'white' | 'black' | 'transparent';
  monochrome: boolean;
  stat: { size: number; mtimeMs: number };
  key: string;
  bbox?: CadBBox;
}

const inFlightRenders = new Map<string, Promise<void>>();
const recentRenderFailures = new Map<string, { at: number; error: string }>();
const FAILURE_TTL_MS = 60_000;

const CadViewParams = Type.Object({
  path: Type.String({
    minLength: 1,
    maxLength: 2000,
    description: 'CAD file path to view. Supports DXF by default; DWG requires a configured global QCAD/ODA-style renderer. Relative paths resolve from the current session cwd.',
  }),
  width: Type.Optional(Type.Integer({
    minimum: 600,
    maximum: 6000,
    description: 'Rendered image width in pixels. Default 2400.',
  })),
  height: Type.Optional(Type.Integer({
    minimum: 600,
    maximum: 6000,
    description: 'Rendered image height in pixels. Default 1800.',
  })),
  background: Type.Optional(Type.Union([
    Type.Literal('white'),
    Type.Literal('black'),
    Type.Literal('transparent'),
  ], {
    description: 'Rendered background. Default white.',
  })),
  monochrome: Type.Optional(Type.Boolean({
    description: 'Render as black/white line art when supported. Default false so CAD layer/entity colors are visible in previews.',
  })),
});

function resolveInputPath(inputPath: string, cwd: string): string {
  return path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(cwd, inputPath);
}

async function statForKey(filePath: string): Promise<{ size: number; mtimeMs: number }> {
  const st = await fs.stat(filePath);
  return { size: st.size, mtimeMs: st.mtimeMs };
}

function cacheKey(input: Record<string, unknown>): string {
  return crypto.createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex')
    .slice(0, 24);
}

function cadPython(): string {
  return process.env.TOWER_CAD_PYTHON || process.env.TOWER_DOCUMENT_PYTHON || 'python3';
}

function runProcess(command: string, args: string[], env: NodeJS.ProcessEnv = process.env, timeoutMs = 180_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`${path.basename(command)} timed out after ${Math.round(timeoutMs / 1000)}s\n${stdout.trim()}\n${stderr.trim()}`.trim()));
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error([`${path.basename(command)} exited ${code}`, stdout.trim(), stderr.trim()].filter(Boolean).join('\n')));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function qcadCandidateDirs(): string[] {
  return [
    process.env.TOWER_CAD_QCAD_DIR,
    process.env.QCAD_DIR,
    '/opt/sandbox-tools/qcad',
    '/opt/sandbox-tools/qcad/current',
    '/opt/qcad',
  ].filter((p): p is string => !!p);
}

function findExecutableInPath(name: string): string | null {
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function findQcadDwg2Bmp(): string | null {
  const pathHit = findExecutableInPath('dwg2bmp');
  if (pathHit) return pathHit;
  for (const dir of qcadCandidateDirs()) {
    const candidate = path.join(dir, 'dwg2bmp');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function renderWithQcad(args: {
  inputPath: string;
  outputPath: string;
  width: number;
  height: number;
  background: 'white' | 'black' | 'transparent';
  monochrome: boolean;
}): Promise<void> {
  const dwg2bmp = findQcadDwg2Bmp();
  if (!dwg2bmp) throw new Error('No global QCAD/ODA-style dwg2bmp renderer found. Install QCAD/ODA as a fleet baseline or set TOWER_CAD_QCAD_DIR.');
  const qcadDir = path.dirname(dwg2bmp);
  const env = {
    ...process.env,
    QT_QPA_PLATFORM: 'offscreen',
    QT_QPA_FONTDIR: path.join(qcadDir, 'fonts', 'qt'),
  };
  const cliArgs = [
    '-platform', 'offscreen',
    '-f',
    '-a',
    '-zoom-all',
    '-c',
    '-b', args.background === 'transparent' ? 'white' : args.background,
    '-x', String(args.width),
    '-y', String(args.height),
    '-o', args.outputPath,
  ];
  if (args.monochrome) cliArgs.push('-n');
  cliArgs.push(args.inputPath);
  await runProcess(dwg2bmp, cliArgs, env);
}

async function renderDxfWithEzdxf(args: {
  inputPath: string;
  outputPath: string;
  width: number;
  height: number;
  background: 'white' | 'black' | 'transparent';
  monochrome: boolean;
  bbox?: CadBBox;
}): Promise<void> {
  const script = String.raw`
import json, sys
try:
    import ezdxf
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from ezdxf.addons.drawing import RenderContext, Frontend
    from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
    from ezdxf.addons.drawing.config import Configuration, ColorPolicy, BackgroundPolicy
except Exception as e:
    print(json.dumps({'ok': False, 'error': 'Missing CAD Python renderer dependency: ' + str(e)}))
    sys.exit(2)

input_path=${JSON.stringify(args.inputPath)}
output_path=${JSON.stringify(args.outputPath)}
width=${JSON.stringify(args.width)}
height=${JSON.stringify(args.height)}
background=${JSON.stringify(args.background)}
monochrome=${args.monochrome ? 'True' : 'False'}
region_bbox=json.loads(${JSON.stringify(JSON.stringify(args.bbox || null))})
try:
    from pathlib import Path
    selected_font = None
    try:
        from matplotlib import font_manager
        for candidate in [
            '/usr/share/fonts/truetype/nanum/NanumGothic.ttf',
            '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
            '/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf',
        ]:
            if Path(candidate).exists():
                selected_font = candidate
                try:
                    font_manager.fontManager.addfont(candidate)
                except Exception:
                    pass
        try:
            from ezdxf.fonts import fonts as ezdxf_fonts
            for folder in ['/usr/share/fonts/truetype/nanum', '/usr/share/fonts/opentype/noto']:
                if Path(folder).exists():
                    ezdxf_fonts.font_manager.scan_folder(Path(folder))
        except Exception:
            pass
        plt.rcParams['font.family'] = ['Noto Sans CJK KR', 'NanumGothic', 'Nanum Gothic', 'DejaVu Sans']
        plt.rcParams['axes.unicode_minus'] = False
    except Exception:
        pass

    doc=ezdxf.readfile(input_path)
    if selected_font:
        font_name = Path(selected_font).name
        for style in doc.styles:
            try:
                style.dxf.font = font_name
                if hasattr(style.dxf, 'bigfont'):
                    style.dxf.bigfont = ''
                try:
                    if style.has_xdata('ACAD'):
                        style.discard_xdata('ACAD')
                except Exception:
                    pass
            except Exception:
                pass
    msp=doc.modelspace()
    fig=plt.figure(figsize=(width/200, height/200), dpi=200)
    ax=fig.add_axes([0, 0, 1, 1])
    if background == 'transparent':
        fig.patch.set_alpha(0)
        ax.set_facecolor((1,1,1,0))
    else:
        fig.patch.set_facecolor(background)
        ax.set_facecolor(background)
    ax.set_aspect('equal')
    ax.axis('off')
    ctx=RenderContext(doc)
    backend=MatplotlibBackend(ax)
    if monochrome:
        color_policy = ColorPolicy.WHITE if background == 'black' else ColorPolicy.BLACK
    else:
        color_policy = ColorPolicy.COLOR
    background_policy = BackgroundPolicy.BLACK if background == 'black' else BackgroundPolicy.WHITE
    config=Configuration(color_policy=color_policy, background_policy=background_policy)
    frontend = Frontend(ctx, backend, config=config)
    if region_bbox:
        from ezdxf import bbox as ezbbox
        min_x = float(region_bbox['minX'])
        min_y = float(region_bbox['minY'])
        max_x = float(region_bbox['maxX'])
        max_y = float(region_bbox['maxY'])
        region_w = max(max_x - min_x, 1.0)
        region_h = max(max_y - min_y, 1.0)
        # Do not draw the whole modelspace for a small region: large plant drawings
        # can spend minutes in ezdxf/matplotlib before axes clipping is applied.
        # Pre-filter entities by a lightly expanded bbox and render only candidates
        # that can affect the requested region preview.
        filter_pad_x = max(region_w * 0.10, 100.0)
        filter_pad_y = max(region_h * 0.10, 100.0)
        fx1, fy1 = min_x - filter_pad_x, min_y - filter_pad_y
        fx2, fy2 = max_x + filter_pad_x, max_y + filter_pad_y
        region_entities = []
        for entity in msp:
            try:
                b = ezbbox.extents([entity], fast=True)
                if not b.has_data:
                    continue
                ex1, ey1, ex2, ey2 = float(b.extmin.x), float(b.extmin.y), float(b.extmax.x), float(b.extmax.y)
                if ex2 < fx1 or fx2 < ex1 or ey2 < fy1 or fy2 < ey1:
                    continue
                region_entities.append(entity)
            except Exception:
                # Keep cheap point-like/text/insert entities by insertion point when
                # ezdxf bbox cannot resolve them; otherwise skip unsupported objects.
                p = getattr(getattr(entity, 'dxf', None), 'insert', getattr(getattr(entity, 'dxf', None), 'location', None))
                if p is not None:
                    try:
                        x, y = float(p.x), float(p.y)
                        if fx1 <= x <= fx2 and fy1 <= y <= fy2:
                            region_entities.append(entity)
                    except Exception:
                        pass
        if region_entities:
            frontend.draw_entities(region_entities)
        else:
            # Empty regions should still render a stable blank canvas rather than
            # falling back to the full drawing and blocking the preview.
            pass
        pad_x = max(region_w * 0.04, 1.0)
        pad_y = max(region_h * 0.04, 1.0)
        ax.set_xlim(min_x - pad_x, max_x + pad_x)
        ax.set_ylim(min_y - pad_y, max_y + pad_y)
    else:
        frontend.draw_layout(msp, finalize=True)
        ax.autoscale()
        ax.margins(0.02)

    # Save a full-frame render instead of bbox_inches='tight'.  Tight exports can
    # produce different image dimensions and leave the drawing visually shifted in
    # Tower's file viewer.  The optional Pillow post-pass trims only real blank
    # pixels, scales the drawing to fit the requested canvas, and pastes it back
    # centered so the preview position is stable even for far-from-origin DXFs.
    raw_output = output_path + '.raw.png'
    fig.savefig(raw_output, dpi=200, facecolor=fig.get_facecolor(), transparent=(background == 'transparent'))
    plt.close(fig)

    try:
        from PIL import Image, ImageChops
        img = Image.open(raw_output).convert('RGBA')
        if background == 'transparent':
            alpha = img.getchannel('A')
            bbox = alpha.getbbox()
            canvas_color = (255, 255, 255, 0)
        else:
            bg_rgb = (0, 0, 0) if background == 'black' else (255, 255, 255)
            rgb = img.convert('RGB')
            bg = Image.new('RGB', rgb.size, bg_rgb)
            bbox = ImageChops.difference(rgb, bg).getbbox()
            canvas_color = (*bg_rgb, 255)

        if bbox and not region_bbox:
            cropped = img.crop(bbox)
            max_w = max(1, int(width * 0.96))
            max_h = max(1, int(height * 0.96))
            scale = min(max_w / cropped.width, max_h / cropped.height)
            cropped = cropped.resize((max(1, int(cropped.width * scale)), max(1, int(cropped.height * scale))), Image.Resampling.LANCZOS)
            canvas = Image.new('RGBA', (width, height), canvas_color)
            x = max(0, (width - cropped.width) // 2)
            y = max(0, (height - cropped.height) // 2)
            canvas.alpha_composite(cropped, (x, y))
            canvas.save(output_path)
        elif img.size != (width, height):
            img.resize((width, height)).save(output_path)
        else:
            img.save(output_path)
        import os
        try:
            os.unlink(raw_output)
        except OSError:
            pass
    except Exception:
        import os
        os.replace(raw_output, output_path)
    print(json.dumps({'ok': True}))
except Exception as e:
    print(json.dumps({'ok': False, 'error': str(e)}))
    sys.exit(1)
`;
  const { stdout } = await runProcess(cadPython(), ['-c', script]);
  try {
    const result = JSON.parse(stdout.trim() || '{}');
    if (!result.ok) throw new Error(result.error || 'DXF renderer failed.');
  } catch (err) {
    if ((err as Error).message.includes('DXF renderer') || (err as Error).message.includes('Missing CAD')) throw err;
    throw new Error(`DXF renderer returned invalid JSON: ${(err as Error).message}\n${stdout.slice(0, 500)}`);
  }
}

export async function inspectCadMetadata(args: { cwd: string; path: string }): Promise<CadMetadataResult> {
  const cadPath = resolveInputPath(args.path, args.cwd);
  const ext = path.extname(cadPath).toLowerCase();
  if (ext !== '.dxf') {
    throw new Error('CAD metadata currently supports .dxf files. DWG inspection requires a native DWG parser/renderer decision.');
  }
  const stat = await statForKey(cadPath);
  const key = cacheKey({ cadPath, size: stat.size, mtimeMs: stat.mtimeMs, inspectVersion: 1 });
  const cacheDir = path.join(CACHE_ROOT, 'inspect-' + key);
  const metadataPath = path.join(cacheDir, 'metadata.json');
  await fs.mkdir(cacheDir, { recursive: true });
  try {
    return JSON.parse(await fs.readFile(metadataPath, 'utf-8')) as CadMetadataResult;
  } catch {}

  const script = String.raw`
import json, math, sys
from collections import Counter, defaultdict
try:
    import ezdxf
    from ezdxf import bbox as ezbbox
except Exception as e:
    print(json.dumps({'ok': False, 'error': 'Missing CAD metadata dependency: ' + str(e)}))
    sys.exit(2)

input_path=${JSON.stringify(cadPath)}
file_size=${JSON.stringify(stat.size)}

def finite_box(b):
    vals=[b.extmin.x,b.extmin.y,b.extmax.x,b.extmax.y]
    return b.has_data and all(math.isfinite(v) for v in vals) and b.extmax.x > b.extmin.x and b.extmax.y > b.extmin.y

def box_dict(x1,y1,x2,y2):
    return {'minX': round(float(x1), 3), 'minY': round(float(y1), 3), 'maxX': round(float(x2), 3), 'maxY': round(float(y2), 3)}

def area(box):
    return max(0.0, box['maxX']-box['minX']) * max(0.0, box['maxY']-box['minY'])

def overlaps(a,b):
    return not (a['maxX'] < b['minX'] or b['maxX'] < a['minX'] or a['maxY'] < b['minY'] or b['maxY'] < a['minY'])

def merge(a,b):
    return box_dict(min(a['minX'],b['minX']), min(a['minY'],b['minY']), max(a['maxX'],b['maxX']), max(a['maxY'],b['maxY']))

def expand(box, ratio=0.06):
    w=max(1.0, box['maxX']-box['minX']); h=max(1.0, box['maxY']-box['minY'])
    return box_dict(box['minX']-w*ratio, box['minY']-h*ratio, box['maxX']+w*ratio, box['maxY']+h*ratio)

try:
    doc=ezdxf.readfile(input_path)
    layouts=[]
    for layout in doc.layouts:
        layouts.append({'name': layout.name, 'entityCount': len(list(layout))})

    msp=doc.modelspace()
    entity_types=Counter()
    layers=Counter()
    layer_colors={}
    boxes=[]
    text_boxes=[]
    for e in msp:
        typ=e.dxftype(); entity_types[typ]+=1
        layer=getattr(e.dxf, 'layer', '0') or '0'; layers[layer]+=1
        try:
            if layer in doc.layers:
                layer_colors[layer]=int(doc.layers.get(layer).dxf.color)
        except Exception:
            pass
        try:
            b=ezbbox.extents([e], fast=True)
            if finite_box(b):
                bd=box_dict(b.extmin.x,b.extmin.y,b.extmax.x,b.extmax.y)
                boxes.append({'type': typ, 'layer': layer, 'bbox': bd})
                if typ in ('TEXT','MTEXT','ATTRIB'):
                    text_boxes.append(bd)
        except Exception:
            pass

    overall=None
    if boxes:
        overall=box_dict(min(x['bbox']['minX'] for x in boxes), min(x['bbox']['minY'] for x in boxes), max(x['bbox']['maxX'] for x in boxes), max(x['bbox']['maxY'] for x in boxes))
    candidates=[]
    if overall:
        candidates.append({'id':'overview','label':'전체 보기','kind':'overview','bbox':overall,'entityCount':len(boxes),'score':1000})
        oa=max(1.0, area(overall))
        # Large block/polyline/table-like objects are good first-pass view anchors.
        raw=[]
        for item in boxes:
            b=item['bbox']; a=area(b); ratio=a/oa
            w=b['maxX']-b['minX']; h=b['maxY']-b['minY']
            if ratio < 0.002 or ratio > 0.92: continue
            if w < 100 or h < 100: continue
            score=ratio*1000
            kind='view'
            if item['type'] == 'INSERT': score += 80
            if item['type'] in ('LWPOLYLINE','POLYLINE'): score += 35
            # Title blocks/tables tend to be wide, low, and near lower/right edges.
            if w > h*1.8 and (b['minY'] < overall['minY'] + (overall['maxY']-overall['minY'])*0.25 or b['minX'] > overall['minX'] + (overall['maxX']-overall['minX'])*0.55):
                kind='title-block' if b['minY'] < overall['minY'] + (overall['maxY']-overall['minY'])*0.22 else 'table'
                score += 120
            raw.append({'kind':kind,'bbox':expand(b,0.08),'entityCount':1,'score':score})
        raw=sorted(raw, key=lambda r: r['score'], reverse=True)
        merged=[]
        for r in raw[:80]:
            if len(merged) >= 10: break
            rb=r['bbox']
            # Skip boxes almost fully contained in an already selected candidate.
            contained=False
            for m in merged:
                mb=m['bbox']
                inter=box_dict(max(rb['minX'],mb['minX']), max(rb['minY'],mb['minY']), min(rb['maxX'],mb['maxX']), min(rb['maxY'],mb['maxY']))
                if inter['maxX'] > inter['minX'] and inter['maxY'] > inter['minY'] and area(inter)/max(1.0, area(rb)) > 0.72:
                    contained=True; break
            if not contained:
                merged.append(r)
        # Enrich entity counts per candidate.
        for idx,r in enumerate(merged, start=1):
            count=sum(1 for item in boxes if overlaps(item['bbox'], r['bbox']))
            label=('Title block' if r['kind']=='title-block' else 'Table / BOM' if r['kind']=='table' else f'View {idx}')
            candidates.append({'id':f'candidate-{idx}','label':label,'kind':r['kind'],'bbox':r['bbox'],'entityCount':count,'score':round(r['score'],2)})

        if text_boxes:
            tb=box_dict(min(b['minX'] for b in text_boxes), min(b['minY'] for b in text_boxes), max(b['maxX'] for b in text_boxes), max(b['maxY'] for b in text_boxes))
            candidates.append({'id':'text-extents','label':'Text extents','kind':'detail','bbox':expand(tb,0.08),'entityCount':len(text_boxes),'score':250})

    result={
        'ok': True,
        'cadPath': input_path,
        'fileSize': file_size,
        'layouts': layouts,
        'layers': [{'name':name,'entityCount':count,'color':layer_colors.get(name)} for name,count in layers.most_common()],
        'entityTypes': dict(entity_types),
        'overallBBox': overall,
        'candidates': candidates[:12],
        'notes': ['Model space candidates are heuristic bbox clusters; verify dimensions in CAD for engineering sign-off.']
    }
    print(json.dumps(result, ensure_ascii=False))
except Exception as e:
    print(json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False))
    sys.exit(1)
`;
  const { stdout } = await runProcess(cadPython(), ['-c', script], process.env, 90_000);
  const parsed = JSON.parse(stdout.trim() || '{}');
  if (!parsed.ok) throw new Error(parsed.error || 'CAD metadata inspection failed.');
  delete parsed.ok;
  await fs.writeFile(metadataPath, JSON.stringify(parsed, null, 2));
  return parsed as CadMetadataResult;
}

async function imageContentForFile(imagePath: string) {
  const data = await fs.readFile(imagePath);
  return { type: 'image' as const, data: data.toString('base64'), mimeType: 'image/png' as const };
}

async function prepareCadRender(args: RenderCadArgs): Promise<PreparedCadRender> {
  assertCadRenderEnabled();
  const cadPath = resolveInputPath(args.path, args.cwd);
  const ext = path.extname(cadPath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(`cad_view supports ${Array.from(SUPPORTED_EXTENSIONS).join(', ')} files, got ${ext || 'no extension'}.`);
  }
  const width = args.width || DEFAULT_WIDTH;
  const height = args.height || DEFAULT_HEIGHT;
  const background = args.background || 'white';
  const monochrome = args.monochrome ?? false;
  const stat = await statForKey(cadPath);
  const renderer: 'ezdxf' | 'qcad' = ext === '.dwg' ? 'qcad' : (findQcadDwg2Bmp() ? 'qcad' : 'ezdxf');
  const bbox = args.bbox;
  const key = cacheKey({ cadPath, size: stat.size, mtimeMs: stat.mtimeMs, width, height, background, monochrome, renderer, bbox, renderVersion: CAD_RENDER_VERSION });
  const cacheDir = path.join(CACHE_ROOT, key);
  const outputPath = path.join(cacheDir, 'view.png');
  await fs.mkdir(cacheDir, { recursive: true });
  let cacheHit = true;
  try { await fs.access(outputPath); } catch { cacheHit = false; }
  return {
    cadPath,
    renderer,
    cacheDir,
    outputPath,
    cacheHit,
    image: { path: outputPath, mimeType: 'image/png', width, height },
    width,
    height,
    background,
    monochrome,
    stat,
    key,
    bbox,
  };
}

async function renderPreparedCad(prepared: PreparedCadRender): Promise<string[]> {
  const notes: string[] = [];
  if (prepared.renderer === 'qcad') {
    await renderWithQcad({
      inputPath: prepared.cadPath,
      outputPath: prepared.outputPath,
      width: prepared.width,
      height: prepared.height,
      background: prepared.background,
      monochrome: prepared.monochrome,
    });
    notes.push('Rendered with global QCAD/ODA-style dwg2bmp renderer.');
  } else {
    await renderDxfWithEzdxf({
      inputPath: prepared.cadPath,
      outputPath: prepared.outputPath,
      width: prepared.width,
      height: prepared.height,
      background: prepared.background,
      monochrome: prepared.monochrome,
      bbox: prepared.bbox,
    });
    notes.push('Rendered with fleet-baseline Python ezdxf renderer.');
    notes.push('DXF rendering is a visual preview; CAD-native line types/fonts/blocks may differ from QCAD/AutoCAD output.');
  }
  await fs.writeFile(path.join(prepared.cacheDir, 'manifest.json'), JSON.stringify({
    sourcePath: prepared.cadPath,
    sourceSize: prepared.stat.size,
    sourceMtimeMs: prepared.stat.mtimeMs,
    renderer: prepared.renderer,
    width: prepared.width,
    height: prepared.height,
    background: prepared.background,
    monochrome: prepared.monochrome,
    bbox: prepared.bbox,
    renderVersion: CAD_RENDER_VERSION,
    createdAt: new Date().toISOString(),
  }, null, 2));
  return notes;
}

async function ensureCadRender(prepared: PreparedCadRender): Promise<string[]> {
  if (prepared.cacheHit) return [];

  if (getCadRenderMode() === 'worker') {
    // Phase 1 optional worker facade: job lifecycle is async/background but still
    // executed in-process. The public API/cache contract stays stable so this can
    // be moved to a separate worker process/container/VM without touching callers.
  }

  const recentFailure = recentRenderFailures.get(prepared.key);
  if (recentFailure && Date.now() - recentFailure.at < FAILURE_TTL_MS) {
    throw new Error(recentFailure.error);
  }
  recentRenderFailures.delete(prepared.key);

  let renderPromise = inFlightRenders.get(prepared.key);
  if (!renderPromise) {
    renderPromise = renderPreparedCad(prepared).then(() => undefined);
    inFlightRenders.set(prepared.key, renderPromise);
    renderPromise.catch((error) => {
      recentRenderFailures.set(prepared.key, { at: Date.now(), error: (error as Error).message });
    }).finally(() => {
      if (inFlightRenders.get(prepared.key) === renderPromise) inFlightRenders.delete(prepared.key);
    });
  }
  await renderPromise;
  return prepared.renderer === 'qcad'
    ? ['Rendered with global QCAD/ODA-style dwg2bmp renderer.']
    : ['Rendered with fleet-baseline Python ezdxf renderer.', 'DXF rendering is a visual preview; CAD-native line types/fonts/blocks may differ from QCAD/AutoCAD output.'];
}

export async function startCadRenderIfNeeded(args: RenderCadArgs): Promise<{
  cadPath: string;
  renderer: 'ezdxf' | 'qcad';
  ready: boolean;
  inFlight: boolean;
  image: { path: string; mimeType: 'image/png'; width: number; height: number };
  error?: string;
}> {
  const prepared = await prepareCadRender(args);
  if (prepared.cacheHit) {
    return { cadPath: prepared.cadPath, renderer: prepared.renderer, ready: true, inFlight: false, image: prepared.image };
  }

  const recentFailure = recentRenderFailures.get(prepared.key);
  if (recentFailure && Date.now() - recentFailure.at < FAILURE_TTL_MS) {
    return { cadPath: prepared.cadPath, renderer: prepared.renderer, ready: false, inFlight: false, image: prepared.image, error: recentFailure.error };
  }
  recentRenderFailures.delete(prepared.key);

  if (!inFlightRenders.has(prepared.key)) {
    const renderPromise = renderPreparedCad(prepared).then(() => undefined);
    inFlightRenders.set(prepared.key, renderPromise);
    renderPromise.catch((error) => {
      recentRenderFailures.set(prepared.key, { at: Date.now(), error: (error as Error).message });
      console.error('[cad-preview] background render error:', (error as Error).message);
    }).finally(() => {
      if (inFlightRenders.get(prepared.key) === renderPromise) inFlightRenders.delete(prepared.key);
    });
  }
  return { cadPath: prepared.cadPath, renderer: prepared.renderer, ready: false, inFlight: true, image: prepared.image };
}

export async function renderCadToCachedImage(args: RenderCadArgs): Promise<RenderCadResult> {
  const prepared = await prepareCadRender(args);
  const notes = await ensureCadRender(prepared);

  return {
    cadPath: prepared.cadPath,
    renderer: prepared.renderer,
    cacheDir: prepared.cacheDir,
    cacheHit: prepared.cacheHit,
    image: prepared.image,
    notes,
  };
}

export function createCadViewTool(ctx: CadViewContext): ToolDefinition {
  return {
    name: 'cad_view',
    label: 'View CAD Drawing',
    description: [
      'View CAD drawings as images for LLM vision analysis.',
      'DXF is supported through the Tower fleet-baseline ezdxf renderer.',
      'DWG requires a configured global QCAD/ODA-style renderer; project-vendored renderers are not assumed.',
      'Rendered images are cached in Tower internal cache and are not written into the project folder.',
    ].join(' '),
    promptSnippet: 'View DXF/DWG CAD drawings by rendering them to internal cached images and sending them to LLM vision.',
    promptGuidelines: [
      'Use cad_view when asked to inspect or understand CAD/DXF/DWG drawings visually.',
      'DXF can render as a visual preview; DWG requires a global QCAD/ODA-style renderer.',
      'Treat cad_view as preview for engineering-critical dimensions, tolerances, or sign-off.',
      'For detailed CAD renderer, artifact, and reporting rules, use runtime_guide_read with name="cad-analysis".',
    ],
    parameters: CadViewParams,
    async execute(_toolCallId: string, params: {
      path: string;
      width?: number;
      height?: number;
      background?: 'white' | 'black' | 'transparent';
      monochrome?: boolean;
    }) {
      try {
        const prepared = await prepareFileRepresentation(params.path, {
          cwd: ctx.cwd,
          projectRoot: ctx.projectRoot,
          sessionId: ctx.sessionId,
          userId: ctx.userId,
        });
        return await withPreparedLocalFile(prepared, undefined, 100 * 1024 * 1024, async localPath => {
          const rendered = await renderCadToCachedImage({
            cwd: ctx.cwd,
            path: localPath,
            width: params.width,
            height: params.height,
            background: params.background,
            monochrome: params.monochrome,
          });
          const content: AgentToolResult<any>['content'] = [{
            type: 'text',
            text: [
              'Viewed CAD drawing with vision [image/png]',
              `[Source: ${prepared.temporary ? prepared.source : rendered.cadPath}]`,
              `[Renderer: ${rendered.renderer}; size: ${rendered.image.width}x${rendered.image.height}; cache: ${rendered.cacheHit ? 'hit' : 'miss'}]`,
              `[Rendered image is stored in Tower internal cache, not in the project folder.]`,
              ...rendered.notes.map((note) => `[Note: ${note}]`),
              '[CAD view]',
            ].join('\n'),
          } as any, await imageContentForFile(rendered.image.path) as any];
          const budgeted = applyModelOutputBudget(content, { maxImages: 1 });
          return {
            content: budgeted.content,
            details: {
              cadViewed: true,
              renderer: rendered.renderer,
              cacheHit: rendered.cacheHit,
              cacheDir: rendered.cacheDir,
              imagePath: rendered.image.path,
              attachmentRepresentation: prepared.decision,
              outputBudget: budgeted,
            },
          };
        });
      } catch (error) {
        return {
          content: [{ type: 'text', text: `[cad_view error] ${(error as Error).message}` } as any],
          details: { cadViewed: false, error: (error as Error).message },
          isError: true,
        } as any;
      }
    },
  } as ToolDefinition;
}
