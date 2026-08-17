import { useMemo } from 'react';
import { parseLooseJson } from '../shared/parse-loose-json';
import { BlockFallback } from '../shared/RichContent';

interface MapMarker {
  lat: number;
  lng: number;
  label?: string;
  popup?: string;
  color?: string;
}

interface MapSpec {
  title?: string;
  center?: [number, number];
  zoom?: number;
  markers?: MapMarker[];
  style?: 'streets' | 'satellite';
}

interface Props {
  raw: string;
  fallbackCode: string;
}

/** Lightweight map block using OpenStreetMap embed (no leaflet dependency).
 *  Renders markers as an interactive iframe with OSM tile layer. */
export default function MapBlock({ raw, fallbackCode }: Props) {
  const parsed = useMemo(() => {
    const r = parseLooseJson(raw);
    if (!r.ok) return { ok: false as const, error: r.error };
    const spec = r.data as MapSpec;
    if (!spec.markers?.length && !spec.center) return { ok: false as const, error: 'Need "markers" or "center"' };
    return { ok: true as const, spec };
  }, [raw]);

  if (!parsed.ok) return <BlockFallback raw={fallbackCode} error={parsed.error} />;
  const { spec } = parsed;

  const markers = spec.markers || [];
  const center = spec.center || (markers.length > 0
    ? [markers.reduce((s, m) => s + m.lat, 0) / markers.length, markers.reduce((s, m) => s + m.lng, 0) / markers.length] as [number, number]
    : [37.5665, 126.9780] as [number, number]); // Default: Seoul
  const zoom = spec.zoom || 13;

  // Build self-contained HTML for the iframe using Leaflet CDN
  const mapHtml = useMemo(() => {
    const markerJs = markers.map((m) => {
      const popup = m.popup || m.label || '';
      const color = m.color || '#3b82f6';
      return `L.circleMarker([${m.lat}, ${m.lng}], {radius: 8, fillColor: '${color}', color: '#fff', weight: 2, fillOpacity: 0.9}).addTo(map)${popup ? `.bindPopup('${popup.replace(/'/g, "\\'")}')` : ''};`;
    }).join('\n');

    return `<!DOCTYPE html>
<html><head>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
<style>html,body{margin:0;padding:0;height:100%}#map{height:100%;width:100%}</style>
</head><body>
<div id="map"></div>
<script>
var map = L.map('map').setView([${center[0]}, ${center[1]}], ${zoom});
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap'
}).addTo(map);
${markerJs}
<\/script>
</body></html>`;
  }, [markers, center, zoom]);

  return (
    <div className="my-3 rounded-lg border border-surface-700/40 bg-surface-900/40 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-surface-800/40 border-b border-surface-700/30">
        <span className="text-[12px] uppercase tracking-wider text-gray-500 font-medium">
          {spec.title || 'Map'}
        </span>
        {markers.length > 0 && (
          <span className="text-[12px] text-gray-500">{markers.length} marker{markers.length > 1 ? 's' : ''}</span>
        )}
      </div>
      <iframe
        srcDoc={mapHtml}
        sandbox="allow-scripts"
        style={{ width: '100%', height: 320, border: 'none' }}
        title="Map"
      />
    </div>
  );
}
