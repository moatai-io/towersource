import { useMemo, useState } from 'react';
import { parseLooseJson, safeStr } from '../shared/parse-loose-json';
import { BlockFallback } from '../shared/RichContent';
import { fileServeUrl } from '../../utils/file-path-links';

interface GalleryImage {
  src: string;
  caption?: string;
  alt?: string;
}

interface GallerySpec {
  title?: string;
  layout?: 'grid' | 'row';
  columns?: number;
  images: GalleryImage[];
}

interface Props {
  raw: string;
  fallbackCode: string;
}

export default function GalleryBlock({ raw, fallbackCode }: Props) {
  const [lightbox, setLightbox] = useState<number | null>(null);

  const parsed = useMemo(() => {
    const r = parseLooseJson(raw);
    if (!r.ok) return { ok: false as const, error: r.error };
    const spec = r.data as GallerySpec;
    if (!spec.images || !Array.isArray(spec.images)) return { ok: false as const, error: 'Missing "images" array' };
    return { ok: true as const, spec };
  }, [raw]);

  if (!parsed.ok) return <BlockFallback raw={fallbackCode} error={parsed.error} />;
  const { spec } = parsed;
  const cols = spec.columns || 3;

  return (
    <>
      <div className="my-3 rounded-lg border border-surface-700/40 bg-surface-900/40 p-3">
        {spec.title && (
          <div className="text-base font-medium text-gray-300 mb-2">{spec.title}</div>
        )}
        <div
          className="grid gap-2"
          style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
        >
          {spec.images.map((img, i) => (
            <div key={i} className="relative group cursor-pointer" onClick={() => setLightbox(i)}>
              <img
                src={fileServeUrl(img.src)}
                alt={img.alt || img.caption || ''}
                loading="lazy"
                className="w-full h-32 object-cover rounded-md border border-surface-700/30 group-hover:opacity-80 transition-opacity"
              />
              {img.caption && (
                <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-[12px] text-gray-200 px-2 py-1 rounded-b-md truncate">
                  {safeStr(img.caption)}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Lightbox */}
      {lightbox !== null && (
        <div
          className="fixed inset-0 z-[9999] bg-black/80 flex items-center justify-center"
          onClick={() => setLightbox(null)}
        >
          <div className="relative max-w-[90vw] max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
            <img
              src={fileServeUrl(spec.images[lightbox].src)}
              alt={spec.images[lightbox].alt || ''}
              className="max-w-full max-h-[85vh] object-contain rounded-lg"
            />
            {spec.images[lightbox].caption && (
              <div className="text-center text-base text-gray-300 mt-2">
                {safeStr(spec.images[lightbox].caption)}
              </div>
            )}
            {/* Navigation */}
            <div className="absolute top-1/2 -translate-y-1/2 -left-12 flex flex-col gap-2">
              {lightbox > 0 && (
                <button
                  onClick={() => setLightbox(lightbox - 1)}
                  className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center"
                >
                  ‹
                </button>
              )}
            </div>
            <div className="absolute top-1/2 -translate-y-1/2 -right-12 flex flex-col gap-2">
              {lightbox < spec.images.length - 1 && (
                <button
                  onClick={() => setLightbox(lightbox + 1)}
                  className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center"
                >
                  ›
                </button>
              )}
            </div>
            {/* Close */}
            <button
              onClick={() => setLightbox(null)}
              className="absolute -top-4 -right-4 w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center"
            >
              ×
            </button>
          </div>
        </div>
      )}
    </>
  );
}
