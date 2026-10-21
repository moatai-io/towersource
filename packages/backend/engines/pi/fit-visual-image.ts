import { execFile } from 'node:child_process';

/** Provider-only representation; never touches source files or persisted images. */
export async function fitVisualImage(part: { data: string; mimeType: string; type: string }, maxBytes: number) {
  if (maxBytes < 1024 || part.data.length > 32 * 1024 * 1024) return null;
  const script = `
from PIL import Image, ImageOps
import sys, io, base64, warnings
warnings.simplefilter('error', Image.DecompressionBombWarning)
Image.MAX_IMAGE_PIXELS = 25000000
budget = int(sys.argv[1])
raw = base64.b64decode(sys.stdin.buffer.read(), validate=True)
with Image.open(io.BytesIO(raw)) as original:
    original.seek(0)
    image = ImageOps.exif_transpose(original).convert('RGBA')
    background = Image.new('RGBA', image.size, 'white')
    background.alpha_composite(image)
    image = background.convert('RGB')
    # Preserve resolution first; PNG is often best for text screenshots.
    for attempt in range(9):
        png = io.BytesIO()
        image.save(png, format='PNG', optimize=True)
        if len(png.getvalue()) <= budget:
            sys.stdout.write('image/png\\n' + base64.b64encode(png.getvalue()).decode())
            break
        fitted = False
        for quality in (90, 80, 70):
            output = io.BytesIO()
            image.save(output, format='JPEG', quality=quality, subsampling=0)
            if len(output.getvalue()) <= budget:
                sys.stdout.write('image/jpeg\\n' + base64.b64encode(output.getvalue()).decode())
                fitted = True
                break
        if fitted: break
        width, height = image.size
        # Stop rather than silently reducing text to an unreadable thumbnail.
        if max(width, height) <= 768: break
        scale = max(0.8, 768 / max(width, height))
        image = image.resize((max(1, int(width * scale)), max(1, int(height * scale))), Image.Resampling.LANCZOS)
`;
  return new Promise<typeof part | null>(resolve => {
    const child = execFile(process.env.TOWER_DOCUMENT_PYTHON || 'python3', ['-c', script, String(Math.floor(maxBytes))], {
      timeout: 20_000, maxBuffer: 32 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) return resolve(null);
      const [mimeType, data] = stdout.trim().split('\n');
      if (!['image/png', 'image/jpeg'].includes(mimeType) || !data || Buffer.from(data, 'base64').length > maxBytes) return resolve(null);
      resolve({ ...part, mimeType, data });
    });
    child.stdin?.on('error', () => { /* Process failure is handled by callback. */ });
    child.stdin?.end(part.data);
  });
}
