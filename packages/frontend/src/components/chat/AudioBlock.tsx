import { useMemo, useRef, useState } from 'react';
import { parseLooseJson } from '../shared/parse-loose-json';
import { BlockFallback } from '../shared/RichContent';
import { fileServeUrl } from '../../utils/file-path-links';

interface AudioSpec {
  src: string;
  title?: string;
  waveform?: boolean;
}

interface Props {
  raw: string;
  fallbackCode: string;
}

export default function AudioBlock({ raw, fallbackCode }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);

  const parsed = useMemo(() => {
    const r = parseLooseJson(raw);
    if (!r.ok) return { ok: false as const, error: r.error };
    const spec = r.data as AudioSpec;
    if (!spec.src) return { ok: false as const, error: 'Missing "src" field' };
    return { ok: true as const, spec };
  }, [raw]);

  if (!parsed.ok) return <BlockFallback raw={fallbackCode} error={parsed.error} />;
  const { spec } = parsed;

  const togglePlay = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) el.pause();
    else el.play();
    setPlaying(!playing);
  };

  const handleTimeUpdate = () => {
    const el = audioRef.current;
    if (el) setProgress(el.currentTime);
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = audioRef.current;
    if (!el || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    el.currentTime = pct * duration;
  };

  const cycleSpeed = () => {
    const speeds = [1, 1.25, 1.5, 2, 0.75];
    const next = speeds[(speeds.indexOf(speed) + 1) % speeds.length];
    setSpeed(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };

  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  return (
    <div className="my-3 rounded-lg border border-surface-700/40 bg-surface-900/40 p-3">
      <audio
        ref={audioRef}
        src={fileServeUrl(spec.src)}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={() => { if (audioRef.current) setDuration(audioRef.current.duration); }}
        onEnded={() => setPlaying(false)}
        preload="metadata"
      />

      <div className="flex items-center gap-3">
        {/* Play button */}
        <button
          onClick={togglePlay}
          className="w-9 h-9 rounded-full bg-primary-600 hover:bg-primary-500 text-white flex items-center justify-center flex-shrink-0 transition-colors"
        >
          {playing ? (
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : (
            <svg className="w-4 h-4 ml-0.5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

        <div className="flex-1 min-w-0">
          {/* Title */}
          {spec.title && (
            <div className="text-sm font-medium text-gray-300 mb-1 truncate">{spec.title}</div>
          )}
          {/* Progress bar */}
          <div
            className="h-1.5 rounded-full bg-surface-700/50 cursor-pointer group"
            onClick={handleSeek}
          >
            <div
              className="h-full rounded-full bg-primary-500 transition-all group-hover:bg-primary-400"
              style={{ width: duration ? `${(progress / duration) * 100}%` : '0%' }}
            />
          </div>
          {/* Time */}
          <div className="flex justify-between mt-0.5 text-[12px] text-gray-500">
            <span>{fmt(progress)}</span>
            <span>{duration ? fmt(duration) : '--:--'}</span>
          </div>
        </div>

        {/* Speed */}
        <button
          onClick={cycleSpeed}
          className="text-[12px] px-1.5 py-0.5 rounded bg-surface-700/40 hover:bg-surface-700/60 text-gray-400 hover:text-gray-200 transition-colors flex-shrink-0"
        >
          {speed}×
        </button>
      </div>
    </div>
  );
}
